# Financie

Rýchle schvaľovanie platieb, 8 kategórií a mesačný cash-flow. PWA pre iPhone (OLED dark).

**Appka:** https://gregorihnat01-bot.github.io/financie/

- Otvor v Safari → Zdieľať → Pridať na plochu.
- Návod na iOS Skratky je v appke: ⚙️ → Automatizácia cez Skratky.
- Dáta sú len v zariadení (LocalStorage). Zálohu urob cez ⚙️ → Exportovať zálohu.

Štruktúra: `index.html`, `css/app.css`, `js/store.js` (stav), `js/parser.js` (EML/PDF/text), `js/ui.js` (UI), `manifest.json`, `sw.js` (offline).
Pri zmene súborov zvýš `VERSION` v `sw.js`, aby sa appka na mobile aktualizovala.
