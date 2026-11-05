# BamLabs Family Hub v0.3.0 (Testversion)

Familienmitglieder, Aufgaben, eigener Familienkalender und **lesende Einbindung vorhandener Home-Assistant-Kalender**.

## Installation
1. Home-Assistant-Backup erstellen.
2. `custom_components/bamlabs_family_hub` aus dieser ZIP nach `/config/custom_components/` kopieren und Dateien ersetzen.
3. Home Assistant vollständig neu starten und die Family-Hub-Oberfläche neu laden.
4. Im Family-Hub-Kalender vorhandene Kalender auswählen und `Auswahl speichern` klicken.

**Wichtig:** Diese Version liest Termine aus Home Assistant, schreibt oder löscht dort nichts. Externe Kalender werden nicht dupliziert. Zum Anzeigen eines Google-Kalenders muss dieser zuerst in Home Assistant als Kalender-Entität vorhanden sein. Eine automatische bidirektionale Synchronisation ist noch nicht enthalten.

Bestehende Mitglieder, Aufgaben und Family-Hub-Termine bleiben in der bisherigen `.storage`-Datei gespeichert. Nicht deinstallieren oder die Datenbank löschen.

## Tests
Python-Syntax, JS-Syntax und Archivstruktur werden geprüft. Der Live-Test auf deiner Home-Assistant-Version steht noch aus.
