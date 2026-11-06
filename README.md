# BamLabs Family Hub v0.3.1 – automatische Kalendersynchronisierung (Testversion)

Diese Version ergänzt v0.3.0 um **automatisches Aktualisieren verknüpfter Home-Assistant-Kalender**.

## Verhalten
- Google Kalender wird über die offizielle Google-Calendar-Integration von Home Assistant verbunden (OAuth). Family Hub selbst fragt Google nicht direkt ab.
- Im Family Hub ausgewählte Kalender bleiben dauerhaft hinterlegt und werden bei jedem Öffnen geladen.
- Solange die Family-Hub-Oberfläche geöffnet ist, werden externe Termine automatisch etwa alle fünf Minuten neu abgefragt. Das Aktualisierungsintervall der Google-Integration selbst kann zusätzliche Verzögerungen verursachen.
- Es werden **keine Kopien von Google-Terminen** im lokalen Family-Hub-Speicher angelegt.
- Die Anbindung ist **einseitig lesend**: neue/geänderte/gelöschte Google-Termine erscheinen automatisch; in Family Hub selbst erstellte Termine werden **noch nicht nach Google geschrieben**.
- Anzeige der letzten erfolgreichen Kalenderabfrage und manuelle Aktualisierung bleiben verfügbar.

## Installation
1. Backup von Home Assistant anlegen.
2. Ordner `custom_components/bamlabs_family_hub` aus dieser ZIP unter `/config/custom_components/` überschreiben.
3. Home Assistant **vollständig neu starten** und Family Hub im Browser neu laden.
4. Google Calendar unter Einstellungen → Geräte & Dienste eingerichtet haben; unter Family Hub → Kalender die gewünschten `calendar.*` auswählen und die Auswahl speichern.

Die bisherigen Mitglieder, Aufgaben und Family-Hub-Termine bleiben in der bestehenden `.storage`-Datei. Die Integration nicht löschen.

## Test
1. Google-Termin anlegen und warten, bis die offizielle Home-Assistant-Kalenderintegration ihn übernommen hat.
2. Family Hub öffnen und Kalender wählen; Termin muss ohne manuellen Import erscheinen.
3. Termin auf Google ändern oder löschen; bei geöffneter Oberfläche nach dem nächsten 5-Minuten-Abgleich prüfen.
4. Family Hub schließen und neu öffnen; dann werden Termine erneut geladen.

**Technischer Hinweis:** Das ist eine Testversion. Python- und JavaScript-Syntax werden statisch geprüft; die reale Google-Anbindung muss auf deiner Home-Assistant-Installation getestet werden.
