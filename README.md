# BamLabs Family Hub v0.3.4 – Versionsabgleich und Aktualisieren

**Dieses Update ersetzt v0.3.3 vollständig.** Familienmitglieder, Aufgaben und Termine bleiben in Home Assistants `.storage` erhalten.

## Neu
- Schaltfläche **🔄 Aktualisieren** oben rechts. Sie lädt die Browseransicht mit einem neuen URL-Parameter, um einen veralteten Seiten-Cache zu umgehen.
- Anzeige der **Frontend- und Backend-Version** direkt oben. Bei Abweichung erscheint ein Hinweis.
- Bestehender Kalender-Assistent aus v0.3.3 bleibt enthalten.

**Wichtig:** Der Button lädt nur die Oberfläche neu, er installiert keine neuen Versionen aus GitHub. Ein neues Release muss zunächst über **Home Assistant → Marketplace → Andere Version installieren** beziehungsweise das angebotene Update installiert werden. Danach Home Assistant vollständig neu starten und den Aktualisieren-Button benutzen.

## Installation
1. Home-Assistant-Backup erstellen.
2. Ordner `custom_components/bamlabs_family_hub` durch die Dateien aus dem ZIP ersetzen. Die übrigen Integrationen und `.storage` nicht löschen.
3. Home Assistant vollständig neu starten.
4. Family Hub öffnen, Versionsangaben oben rechts vergleichen und ggf. 🔄 Aktualisieren anklicken.

Getestet: Python-Kompilierung, JavaScript-Syntaxprüfung und ZIP-Struktur. Kein Live-Test in Home Assistant.

## v0.3.5
- Kalender einer Person zuweisen: Anzeigen der importierten Termine in deren Familienfarbe.
- Home-Assistant-Kalender werden weiterhin nur lesend eingebunden; Google Calendar muss zuerst über Home Assistant eingerichtet werden.
- Daten aus 0.3.4 bleiben im vorhandenen Home-Assistant-Speicher.

## v0.3.6 – Kinderansicht am Handy
- Persönliche Übersicht mit offenen, erledigten und heute fälligen Aufgaben.
- Überfällige Aufgaben deutlich markieren.
- Erledigte Aufgaben im Aufgaben-Tab anzeigen und bei Bedarf wieder öffnen.
- Auf „Mein Tag“ nur die nächsten fünf anstehenden Termine darstellen.
- Größere Touchflächen für Aufgaben und Buttons auf kleinen Displays.
- Die bisherigen QR-Codes und Home-Assistant-Benutzerrechte bleiben unverändert.
- Nur lokale Daten; importierte Google-Termine werden weiterhin ausschließlich im Elternkalender angezeigt.

## Version 0.3.9
- Kalenderauswahl und Personenzuordnung gesammelt unter Einstellungen → Home-Assistant-Kalender einblenden.
- Kalender zeigt nur noch eine Schaltfläche zu den Kalender-Einstellungen.
- Elternübersicht: erledigte/offene/überfällige Aufgaben pro Person mit Fortschrittsbalken.
- Aufgabenansicht: nach Familienmitglied filtern.
- Aufgaben und Termine bleiben im lokalen HA-Speicher unverändert.


## v0.3.11 – Wochenplan
Der Eltern-Menüpunkt „Wochenplan“ zeigt sieben Tage mit Aufgaben und Terminen. Aufgaben ohne Fälligkeitsdatum bleiben in der Aufgabenliste.


## Neu in v0.3.12: Erinnerungen
Unter Einstellungen → Aufgabenerinnerungen aktivieren. Täglich zur gewählten Uhrzeit
erscheint eine Home-Assistant-Benachrichtigung mit heute fälligen und optional überfälligen Aufgaben.
Mit „Test-Erinnerung“ lässt sich die Funktion manuell prüfen. Kein Handy-Push.
