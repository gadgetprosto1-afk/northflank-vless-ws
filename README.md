# VLESS over WebSocket для Northflank

_Создано 23.11.2026. Причина: бесплатный аккаунт Northflank публикует только HTTP/HTTPS-порты,
TCP-порт требует платный L4-балансировщик. WebSocket через HTTPS-порт работает — поэтому
выход сделан как VLESS-over-WS, а не SOCKS._

## Что это

Один файл `server.js` на чистом Node.js 22, без зависимостей:

- `GET /health` → `ok` (проверка живости);
- `Upgrade: websocket` на пути `/ws` → VLESS-сессия;
- расшифровка маски WS-кадров, разбор заголовка VLESS, TCP-исходящее через `net.connect`.

Локально проверено: `node test-client.js` → `HTTP/1.1 200 OK` через туннель.

## UUID

По умолчанию `3f9a1c72-5b84-4e0d-9a1f-7c2e8b6d4f03`. Меняется переменной `VLESS_UUID`,
путь — переменной `WS_PATH`.

## Деплой

1. Репозиторий подключён к сервису Northflank, Dockerfile собирается автоматически.
2. Порт `3000` объявлен в `EXPOSE` — Northflank создаёт публичный HTTP/HTTPS-порт.
3. Публичный адрес выглядит как `p3000--<service>--<hash>.code.run`, порт 443.

## Клиент (mihomo)

```yaml
proxies:
  - name: "nf-01"
    type: vless
    server: p3000--<service>--<hash>.code.run
    port: 443
    uuid: 3f9a1c72-5b84-4e0d-9a1f-7c2e8b6d4f03
    tls: true
    network: ws
    servername: p3000--<service>--<hash>.code.run
    ws-opts:
      path: /ws
      headers:
        Host: p3000--<service>--<hash>.code.run
```

## Ограничения

- Northflank тарифицирует egress **$0,06/ГБ** из $20 бесплатного кредита: грубо 250–300 ГБ
  в месяц, если compute съест около $5.
- Один 4K-поток — 4–5 МБ/с, то есть 12 часов ≈ 135–243 ГБ. Одного выхода хватает впритык.
- mihomo и sing-box ведут WebSocket по TCP: QUIC не上使用, YouTube уйдёт на TCP.
