#!/usr/bin/env node
// Замер скорости скачивания: 10 последовательных запросов к одному адресу.
// Методика и единицы описаны в README.md.
import { downloadOnce, summarize } from './lib/measure.mjs';

const REQUESTS = 10;

const USAGE = `Использование: node speedtest.mjs <url>

Пример:
  node speedtest.mjs "https://speed.cloudflare.com/__down?bytes=10000000"`;

// Форматирование для вывода: 1 МБ = 10^6 байт, 1 Мбит = 10^6 бит
const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(2)} МБ`;
const fmtMs = (ms) => `${Math.round(ms)} мс`;
const fmtMbit = (bytes, ms) => `${((bytes * 8) / 1e6 / (ms / 1000)).toFixed(1)} Мбит/с`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length !== 1) {
    console.error(USAGE);
    return 2;
  }

  let url;
  try {
    url = new URL(args[0]);
  } catch {
    console.error(`Некорректный адрес: ${args[0]}`);
    return 2;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error(`Поддерживаются только http и https, получено: ${url.protocol}`);
    return 2;
  }

  console.log(`Адрес: ${url.href}`);
  console.log(`${REQUESTS} запросов подряд, каждый по новому соединению\n`);

  // Строго последовательно: следующий запрос стартует после полного ответа на предыдущий
  const results = [];
  for (let i = 1; i <= REQUESTS; i++) {
    const r = await downloadOnce(url);
    results.push(r);

    const n = `${String(i).padStart(2)}/${REQUESTS}`;
    if (r.ok) {
      const redirectNote = r.redirects ? `   редиректов: ${r.redirects}` : '';
      console.log(
        `${n}  ${fmtMB(r.bytes).padStart(11)}  ${fmtMs(r.ms).padStart(9)}  ` +
          `${fmtMbit(r.bytes, r.ms).padStart(13)}${redirectNote}`,
      );
    } else {
      console.log(`${n}  ошибка: ${r.error} (через ${fmtMs(r.ms)})`);
    }
  }

  const s = summarize(results);
  console.log(`\nУспешных запросов: ${s.succeeded} из ${s.requests}`);
  if (s.succeeded === 0) {
    console.error('Ни один запрос не завершился успешно, скорость не посчитать.');
    return 1;
  }

  const lastOk = results.findLast((r) => r.ok);
  if (lastOk.finalUrl !== url.href) {
    console.log(`Адрес после редиректов: ${lastOk.finalUrl}`);
  }
  console.log(
    `Среднее время запроса: ${fmtMs(s.avgMs)} (мин ${fmtMs(s.minMs)}, макс ${fmtMs(s.maxMs)})`,
  );
  console.log(`Скачано всего: ${fmtMB(s.totalBytes)} (${s.totalBytes} байт)`);
  console.log(
    `Скорость скачивания: ${(s.megabitsPerSec ?? 0).toFixed(1)} Мбит/с ` +
      `(${(s.megabytesPerSec ?? 0).toFixed(2)} МБ/с)`,
  );
  return 0;
}

process.exitCode = await main();
