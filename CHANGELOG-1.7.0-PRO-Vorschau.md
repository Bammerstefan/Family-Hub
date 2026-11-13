# BamLabs Family Hub PRO v1.7.0 – Shop-Lizenzschnittstelle

- Exaktes signiertes Lizenzformat von BamLabs License Manager v0.4.x implementiert (`schema=1`, `product=family_hub`, `modules`, `perpetual`).
- Admin-Aktivierung lädt öffentlichen Ed25519-Schlüssel über HTTPS von `bamlabs.at/wp-json/bamlabs/v1/public-key` und pinnt ihn nach erfolgreicher Aktivierung.
- Online-Statusprüfung via `/license-status/<license_id>` bei Aktivierung und automatisch etwa alle 6h.
- Zeitweiser Internetausfall: bisher bestätigte Lizenz bis 14 Tage weiter gültig. Widerruf oder unbekannte Lizenz deaktiviert Status sofort nach bestätigter Prüfung.
- Status sowie Teilmodule sichtbar, niemals Lizenzschlüssel im Browser-State; manuelle Aktualisierung.
- `BL-FH-ALL-PRO` berechtigt zu allen drei PRO-Modulen; andere Shop-SKUs enthalten jeweils Teilmodule.
- FREE unverändert; aktuelle PRO-Vorschau bleibt unabhängig vom Lizenzstatus testbar – echtes serverseitiges Feature-Gating folgt nach Live-Test.

## WordPress-Plugin v0.4.1
- Unveränderte bestehende Shop-Lizenzen, Module, Signaturen und Bestelllogik.
- Neuer öffentlicher REST-Endpunkt `GET /wp-json/bamlabs/v1/public-key` gibt ausschließlich den PUBLIC Ed25519-Key aus.
- Der private Signierschlüssel verbleibt auf dem Shopserver; seine PEM-Datei darf nicht veröffentlicht werden.

## Installation/Reihenfolge
1. Vollständige Sicherung von WordPress, Datenbank und Home Assistant erstellen.
2. WordPress Plugin 0.4.1 installieren und `/wp-json/bamlabs/v1/public-key` prüfen (öffentlich, HTTPS, liefert public_key).
3. Family Hub v1.7.0 installieren.
4. Mit bezahlter privater WooCommerce-Testbestellung SKU `BL-FH-ALL-PRO` im BamLabs-Kundenkonto Schlüssel für die angezeigte Family-Hub-Installations-ID erstellen.
5. Token in HA Einstellungen > PRO-Lizenz eingeben und prüfen. Danach ggf. manuellen Refresh testen.

WICHTIG: Keine Kundenverkäufe starten, bevor Live-Tests, Rechteprüfung und Widerrufsverhalten erfolgreich sind.
