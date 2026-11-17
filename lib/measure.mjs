// Замер одного HTTP(S)-запроса: новое соединение, ручные редиректы,
// подсчёт байт тела потоком (данные сразу выбрасываются, в памяти не копятся).
import http from 'node:http';
import https from 'node:https';

export const DEFAULT_OPTIONS = {
  // Таймаут бездействия: сколько ждать хоть каких-то данных от сервера.
  // Общий лимит на запрос не ставим: тяжёлый файл на медленном канале
  // может законно качаться долго.
  idleTimeoutMs: 30_000,
  maxRedirects: 10,
  userAgent: 'download-speed-test/1.0 (Node.js)',
};

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Скачивает адрес один раз и возвращает результат замера.
 * Время: от отправки запроса (включая DNS, TCP, TLS и редиректы)
 * до последнего байта тела.
 * Сетевые ошибки и ошибочные статусы не бросаются, а возвращаются в поле error.
 *
 * @param {string | URL} url адрес с протоколом http или https
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {Promise<{ok: boolean, status?: number, bytes: number, ms: number,
 *   redirects: number, finalUrl: string, error?: string}>}
 */
export function downloadOnce(url, options = {}) {
  const { idleTimeoutMs, maxRedirects, userAgent } = { ...DEFAULT_OPTIONS, ...options };

  return new Promise((resolve) => {
    let target = new URL(url);
    let redirects = 0;
    let attempt = 0; // номер текущего запроса в цепочке редиректов
    let req = null;
    let timer = null;
    let done = false;
    const startedAt = performance.now();

    // Единая точка завершения: останавливаем секундомер и закрываем соединение
    const finish = (result) => {
      if (done) return;
      done = true;
      const ms = performance.now() - startedAt;
      clearTimeout(timer);
      req?.destroy();
      resolve({ bytes: 0, ...result, ms, redirects, finalUrl: target.href });
    };

    // Таймер бездействия перезапускается на каждом событии от сервера
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish({ ok: false, error: `нет данных от сервера ${idleTimeoutMs / 1000} с` }),
        idleTimeoutMs,
      );
    };

    const send = () => {
      const my = ++attempt;
      // События от предыдущих запросов цепочки (до редиректа) игнорируем
      const isCurrent = () => my === attempt;
      const client = target.protocol === 'https:' ? https : http;

      touch();
      req = client.get(
        target,
        {
          // Холодный старт: agent: false = новое TCP(+TLS) соединение на каждый запрос
          agent: false,
          headers: {
            // Соединение закрываем сами после ответа (см. finish), а не просим сервер.
            // При Connection: close некоторые серверы (например, http-сервер Node
            // на Windows) обрывают соединение RST-пакетом, и клиент теряет ответ
            // с ECONNRESET. Новое соединение на каждый запрос даёт agent: false.
            Connection: 'keep-alive',
            // Без сжатия: считаем байты, реально пришедшие по сети
            'Accept-Encoding': 'identity',
            // Просим промежуточные кэши не отдавать сохранённую копию
            'Cache-Control': 'no-cache',
            'User-Agent': userAgent,
          },
        },
        (res) => onResponse(res, isCurrent),
      );
      req.on('error', (err) => {
        if (isCurrent()) finish({ ok: false, error: describeError(err) });
      });
    };

    const onResponse = (res, isCurrent) => {
      const status = res.statusCode;
      let bytes = 0;

      // Подписываемся сразу: при закрытии соединения res может выдать ошибку,
      // и без обработчика процесс упадёт
      res.on('error', (err) => {
        if (isCurrent()) finish({ ok: false, status, bytes, error: describeError(err) });
      });
      if (!isCurrent() || done) {
        res.destroy();
        return;
      }
      touch();

      if (REDIRECT_CODES.has(status) && res.headers.location) {
        res.destroy(); // тело редиректа не нужно
        if (redirects >= maxRedirects) {
          finish({ ok: false, status, error: `больше ${maxRedirects} редиректов` });
          return;
        }
        let next;
        try {
          next = new URL(res.headers.location, target);
        } catch {
          finish({ ok: false, status, error: `некорректный Location: ${res.headers.location}` });
          return;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          finish({ ok: false, status, error: `редирект на неподдерживаемый протокол ${next.protocol}` });
          return;
        }
        redirects += 1;
        target = next;
        send();
        return;
      }

      if (status < 200 || status >= 300) {
        // Ошибочный ответ (например, 429 с HTML-страницей) — это не данные
        finish({ ok: false, status, error: `HTTP ${status}` });
        return;
      }

      res.on('data', (chunk) => {
        bytes += chunk.length;
        touch();
      });
      res.on('end', () => {
        // complete === false, если соединение оборвалось раньше конца тела
        if (res.complete) finish({ ok: true, status, bytes });
        else finish({ ok: false, status, bytes, error: 'соединение оборвалось до конца ответа' });
      });
    };

    send();
  });
}

/**
 * Сводка по серии замеров. Учитываются только успешные запросы.
 *
 * Скорость = общий объём / суммарное время (то же, что средний объём / среднее время).
 * Делить общий объём на СРЕДНЕЕ время нельзя: скорость завысится в N раз.
 */
export function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const times = ok.map((r) => r.ms);
  const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = times.reduce((sum, ms) => sum + ms, 0);
  const seconds = totalMs / 1000;

  return {
    requests: results.length,
    succeeded: ok.length,
    totalBytes,
    totalMs,
    avgMs: ok.length ? totalMs / ok.length : null,
    minMs: ok.length ? Math.min(...times) : null,
    maxMs: ok.length ? Math.max(...times) : null,
    // 1 Мбит = 10^6 бит, 1 МБ = 10^6 байт (десятичные единицы, как у провайдеров)
    megabitsPerSec: seconds > 0 ? (totalBytes * 8) / 1e6 / seconds : null,
    megabytesPerSec: seconds > 0 ? totalBytes / 1e6 / seconds : null,
  };
}

// У AggregateError (у хоста несколько IP, и все отказали) пустой message — берём code
function describeError(err) {
  return err?.message || err?.code || String(err);
}
