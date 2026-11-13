# Family Hub PRO 1.5.0 – Lizenzgrundlage (Entwicklervorschau)

- Stabile Installations-ID im Home-Assistant-Speicher; eine ID gilt für alle Familienmitglieder.
- Administrator-Ansicht unter Einstellungen und zugriffsgeschützter WebSocket-Befehl `pro_license_info`.
- Keine erfundene Lizenzserver-Verbindung: Status ist bewusst `integration_pending`; keine Schlüsselübertragung, keine Scheinaktivierung.
- PRO-Vorschaufunktionen bleiben vorerst für lokale Tests verfügbar. **Nicht öffentlich verkaufen oder als lizenzgeschützt ausgeben.**
- Vor der Produktionsfreigabe: tatsächlichen API-Vertrag des BamLabs License Managers einbinden, signierte Antworten prüfen, Freischaltung serverseitig in allen PRO-Endpunkten durchsetzen, Verlängerung/Deaktivierung/Transfer prüfen.
- App, Backend und Panel-Ladepfad auf 1.5.0.
