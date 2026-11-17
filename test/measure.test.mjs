// Тесты на локальном HTTP-сервере: без интернета, проверяют логику замера
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { downloadOnce, summarize } from '../lib/measure.mjs';

const FILE_SIZE = 16 * 64 * 1024; // 1 МиБ

let server;
let base;
let connections = 0;
let lastHeaders = null;

before(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    switch (req.url) {
      case '/file': {
        // Без Content-Length (chunked): объём можно узнать только посчитав байты
        const chunk = Buffer.alloc(64 * 1024);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        for (let i = 0; i < 16; i++) res.write(chunk);
        res.end();
        break;
      }
      case '/redirect':
        res.writeHead(302, { Location: '/file' }).end();
        break;
      case '/loop':
        res.writeHead(302, { Location: '/loop' }).end();
        break;
      case '/not-found':
        res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>Не найдено</h1>');
        break;
      case '/hang':
        // Заголовки и один байт, а дальше тишина
        res.writeHead(200);
        res.write('x');
        break;
      case '/broken':
        // Обещаем 1000 байт, отдаём 500 и рвём соединение
        res.writeHead(200, { 'Content-Length': 1000 });
        res.write(Buffer.alloc(500));
        setTimeout(() => res.socket.destroy(), 20);
        break;
      default:
        res.writeHead(500).end();
    }
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('считает байты тела без Content-Length', async () => {
  const r = await downloadOnce(`${base}/file`);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.bytes, FILE_SIZE);
  assert.ok(r.ms > 0);
});

test('просит ответ без сжатия и без кэша, представляется своим User-Agent', async () => {
  await downloadOnce(`${base}/file`);
  assert.equal(lastHeaders['accept-encoding'], 'identity');
  assert.equal(lastHeaders['cache-control'], 'no-cache');
  assert.match(lastHeaders['user-agent'], /download-speed-test/);
});

test('каждый запрос открывает новое соединение (холодный старт)', async () => {
  const before = connections;
  for (let i = 0; i < 3; i++) await downloadOnce(`${base}/file`);
  assert.equal(connections - before, 3);
});

test('идёт по редиректу и считает только тело итогового ответа', async () => {
  const r = await downloadOnce(`${base}/redirect`);
  assert.equal(r.ok, true);
  assert.equal(r.redirects, 1);
  assert.equal(r.finalUrl, `${base}/file`);
  assert.equal(r.bytes, FILE_SIZE);
});

test('ограничивает число редиректов', async () => {
  const r = await downloadOnce(`${base}/loop`, { maxRedirects: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /редирект/);
});

test('ошибочный статус не считается скачанными данными', async () => {
  const r = await downloadOnce(`${base}/not-found`);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.bytes, 0);
  assert.equal(r.error, 'HTTP 404');
});

test('обрывает запрос, если сервер замолчал', async () => {
  const r = await downloadOnce(`${base}/hang`, { idleTimeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /нет данных/);
  assert.ok(r.ms < 2000);
});

test('обрыв соединения посреди тела — ошибка, а не успех', async () => {
  const r = await downloadOnce(`${base}/broken`);
  assert.equal(r.ok, false);
});

test('ошибка подключения возвращается, а не бросается', async () => {
  // Занимаем свободный порт и сразу освобождаем: на нём никто не слушает
  const tmp = http.createServer();
  await new Promise((resolve) => tmp.listen(0, '127.0.0.1', resolve));
  const { port } = tmp.address();
  await new Promise((resolve) => tmp.close(resolve));

  const r = await downloadOnce(`http://127.0.0.1:${port}/`);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('summarize: скорость = общий объём / суммарное время, неудачные не учитываются', () => {
  const ok = { ok: true, bytes: 10_000_000, ms: 4000 };
  const failed = { ok: false, bytes: 0, ms: 30_000, error: 'HTTP 429' };
  const s = summarize([...Array(10).fill(ok), failed]);

  assert.equal(s.requests, 11);
  assert.equal(s.succeeded, 10);
  assert.equal(s.totalBytes, 100_000_000);
  assert.equal(s.avgMs, 4000);
  // 100 МБ за 40 с = 2,5 МБ/с = 20 Мбит/с (а не 200, как было бы при делении на среднее время)
  assert.equal(s.megabytesPerSec, 2.5);
  assert.equal(s.megabitsPerSec, 20);
});

test('summarize: без успешных запросов скорость не считается', () => {
  const s = summarize([{ ok: false, bytes: 0, ms: 100, error: 'x' }]);
  assert.equal(s.succeeded, 0);
  assert.equal(s.avgMs, null);
  assert.equal(s.megabitsPerSec, null);
});
