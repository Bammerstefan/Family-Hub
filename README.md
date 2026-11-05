# BamLabs Family Hub v0.2.1

Kostenlose Home-Assistant-Integration: Familienmitglieder, Aufgaben und Familienkalender.

## Fix in 0.2.1
- Kalenderbefehle werden beim Laden des Konfigurationseintrags zuverlässig registriert.
- Browser-Cache-Busting auf 0.2.1 erhöht.
- Familienmitglieder, Aufgaben und Termine bleiben unverändert gespeichert.

## Installation / Update
1. Home-Assistant-Backup erstellen.
2. `custom_components/bamlabs_family_hub` aus dieser ZIP-Datei in das Home-Assistant-Konfigurationsverzeichnis kopieren und bestehende Dateien ersetzen.
3. Home Assistant neu starten, die Browseroberfläche neu laden.
4. Links **Family Hub** öffnen.

Bestehende Familienmitglieder und Aufgaben bleiben in `.storage/bamlabs_family_hub.data` gespeichert. Die Datei **nicht löschen**.

## Enthalten in 0.2.1
- Eigener Familienkalender: Monats-, Wochen-, Tagesansicht.
- Ganztägige und zeitlich begrenzte Termine.
- Mehrfachzuordnung zu Familienmitgliedern mit Farbkennung.
- Wiederholung täglich, wöchentlich, monatlich und jährlich (gesamte Serie).
- Termine erstellen, bearbeiten und löschen.
- Aktuelle Termine auf dem Dashboard.

**Grenzen:** Keine Google-/Home-Assistant-Kalendersynchronisierung und keine Bearbeitung einzelner Wiederholungsinstanzen. Admin-Zugriff wie bisher. Lokale Speicherung.

**Testversion:** Syntaxprüfungen erfolgreich; Funktionstest in echter Home-Assistant-Installation erforderlich.
