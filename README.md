# BamLabs Family Hub v0.1.0 (Testversion)

Kostenlose, eigenständige Home-Assistant-Integration zur lokalen Verwaltung von Familienmitgliedern und Aufgaben.

## Funktionen
- Home Assistant Einrichtungsdialog (Config Flow)
- Eigenes Panel im Seitenmenü: **Family Hub**
- Familienmitglieder mit Name und Farbe erstellen, ändern, löschen
- Aufgaben mit Priorität, Fälligkeitsdatum, Beschreibung und mehreren Zuständigen
- Aufgaben abschließen, wieder öffnen, bearbeiten und löschen
- Tagesübersicht mit offenen und fälligen Aufgaben
- Lokal gespeicherte Daten über Home Assistants Store (`.storage/bamlabs_family_hub.data`)
- Responsive Ansicht für Mobilgeräte und Tablets

## Installation (manuell für ersten Test)
1. Vollständiges Home-Assistant-Backup erstellen.
2. Den Ordner `custom_components/bamlabs_family_hub` nach `/config/custom_components/` kopieren.
3. Home Assistant vollständig neu starten.
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → BamLabs Family Hub** auswählen.
5. Das Panel **Family Hub** in der Seitenleiste öffnen.

**Keine Veränderung** an der Integration `meal_planner` und am BamLabs License Manager.

## Einschränkungen der 0.1.0
- Erste Testversion, noch nicht auf einer echten Home-Assistant-Installation geprüft.
- Aus Sicherheitsgründen ist das Panel derzeit nur für Administratoren sichtbar; Familienkonten/Rollen folgen später.
- Kalenderanbindung, Push-Erinnerungen, Kinder-/Schulmodule und PRO-Lizenzen sind noch nicht implementiert.
- Kalender und Termine werden nicht importiert, keine Cloud- oder Google-Verbindung.
- Daten bleiben lokal; Backups erfolgen über Home Assistant.

## GitHub/Marketplace
Für ein eigenes Repository die ZIP-Inhalte in das Repository-Stammverzeichnis laden und eine Release-Version `v0.1.0` erstellen. Die Integration benötigt keine zusätzlichen Python-Bibliotheken.

## Tests
Python-Syntax und JavaScript-Syntax wurden überprüft. Ein Live-Test mit Home Assistant steht aus.
