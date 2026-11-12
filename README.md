# Financie

Rýchle schvaľovanie platieb, 8 kategórií a mesačný cash-flow. PWA pre iPhone (OLED dark).

**Appka:** https://gregorihnat01-bot.github.io/financie/

- Otvor v Safari → Zdieľať → Pridať na plochu.
- Návod na iOS Skratky je v appke: ⚙️ → Automatizácia cez Skratky.
- Dáta sú len v zariadení (LocalStorage). Zálohu urob cez ⚙️ → Exportovať zálohu.

Štruktúra: `index.html`, `css/app.css`, `js/store.js` (stav), `js/parser.js` (EML/PDF/text), `js/ui.js` (UI), `manifest.json`, `sw.js` (offline).
Pri zmene súborov zvýš `VERSION` v `sw.js`, aby sa appka na mobile aktualizovala.

## Automatický import z Gmailu

`apps-script/Code.gs` beží vo vlastnom Google účte, Gmail iba číta a vracia len notifikácie banky (`SENDERS`, teraz ČSOB `info@servis.csob.sk`).
Appka si ho volá pri štarte a pri každom návrate do appky a platby rozpozná tým istým parserom ako import EML.

1. script.google.com → Nový projekt → vlož `Code.gs`.
2. Nasadiť → Nové nasadenie → Webová aplikácia (Spustiť ako: Ja, Prístup: Ktokoľvek).
3. Spusti funkciu `setup` → z protokolu skopíruj *ODKAZ PRE APPKU*.
4. V appke ⚙️ → Automatický import z Gmailu → vlož odkaz → Pripojiť.

Po úprave `Code.gs` treba v Apps Scripte urobiť Nasadiť → Spravovať nasadenia → upraviť → Nová verzia.
