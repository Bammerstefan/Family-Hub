# BamLabs Family Hub v0.3.2 – Einstellungen & Kinder-Handyzugang (Testversion)

Das Update basiert auf v0.3.1 und ergänzt einen Menüpunkt **⚙️ Einstellungen** und die erste sichere **Kinder-Ansicht**.

## Das ist neu

- Menüpunkt Einstellungen für Home-Assistant-Administratoren
- „Kinder & Handy-Zugang“: bestehende Familienmitglieder mit **normalen, nicht administrativen Home-Assistant-Benutzern** verbinden
- Für jedes verknüpfte Kind eigener QR-Code, der den Family-Hub-Link öffnet. Im Code steckt **kein Passwort, API-Token und kein dauerhafter Login-Schlüssel**.
- Nach dem ersten Login zeigt Family Hub automatisch die einfache Kinderansicht: eigene Aufgaben sehen, abhaken und hinzufügen; eigene Termine sehen und hinzufügen.
- Kinder sehen über die Family-Hub-API ausschließlich Aufgaben und Family-Hub-Termine, die ihrem Familienmitglied zugeordnet sind; keine Familienverwaltung, keine Einstellungen und keine externen Kalenderdaten.
- Eltern können eine Zuordnung wieder entfernen und damit den Family-Hub-Kinderzugang widerrufen.
- Bisherige Familienmitglieder, Aufgaben und Termine bleiben in der bestehenden `.storage` erhalten.

## Einrichtung – einmal durch die Eltern

1. Backups von Home Assistant und der Integration erstellen.
2. `custom_components/bamlabs_family_hub` nach `/config/custom_components/` kopieren und vorhandene Dateien überschreiben.
3. **Home Assistant vollständig neu starten** und die Oberfläche neu laden.
4. In Home Assistant unter **Einstellungen → Personen → Benutzer** (je nach Version können die Menüpunkte anders heißen) für jedes Kind ein eigenes **normales Benutzerkonto ohne Administratorrechte** erstellen. Keine Zugangsdaten eines Eltern-Admins teilen.
5. Family Hub → **Einstellungen → Kinder & Handy-Zugang** → **Kinderkonten anzeigen**. Jedes Kind mit seinem Home-Assistant-Benutzer verbinden.
6. Bei dem Kind auf **QR-Code anzeigen** klicken. Mit dem Handy scannen und beim ersten Mal mit seinem Konto anmelden.
7. Ein Kind kann seine eigenen Aufgaben abhaken/erstellen und Termine hinzufügen. Ein Admin kann die Zuordnung unter Einstellungen wieder aufheben.

## Wichtige Sicherheitsgrenzen

**QR-Code = komfortabler Link, keine automatische Anmeldung.** Er gibt selbst **keine Berechtigung**. Home Assistant verlangt beim ersten Zugriff einen Login. Ein QR-Code kann erneut verwendet werden, aber nur ein dem Kind zugeordnetes, aktives Benutzerkonto darf seine Daten bearbeiten.

**Die Einschränkungen gelten für Family Hub**, nicht für ganz Home Assistant: Was Kinder sonst in Home Assistant sehen, hängt von dessen eigenen Benutzer-, Dashboard- und Berechtigungseinstellungen ab. Überprüfe daher die übrigen Home-Assistant-Dashboards, bevor du Kinderkonten ausgibst. Aktuell gibt es in Home Assistant keine vollständige kindgerechte Rollenverwaltung für alle Integrationen.

Der QR-Link verwendet die Adresse, über die du Family Hub im Browser geöffnet hast. Damit die Kinderhandys ihn erreichen, müssen sie auf dieselbe Home-Assistant-Adresse zugreifen können (im WLAN oder über einen von dir sicher eingerichteten externen Zugriff). Bei rein lokalem HTTP bitte nicht unsichere Portfreigaben zum Internet einrichten.

**Noch nicht enthalten:** QR-basierte Anmeldung ohne Home-Assistant-Konto, eingeschränkte native Home-Assistant-Konten jenseits von Family Hub, Bearbeiten/Löschen bestehender Elterntermine, Google-Kalender-Schreibzugriff und optionale Elternfreigabe einzelner Kindereinträge.

## Testfälle

1. Elternkonto: Mitglieder, Aufgaben, Kalender, Einstellungen wie bisher bedienbar.
2. Kind A: ausschließlich eigene Aufgaben/Family-Hub-Termine angezeigt; abhaken und selbst Einträge anlegen.
3. Kind B: keine Daten von A, sofern nicht gemeinsam zugeordnet.
4. Nicht zugeordnetes Home-Assistant-Konto: Family Hub verweigert den Zugriff.
5. Nach „Noch nicht verbunden“: Ehemaliges Kinderkonto darf Family Hub nicht mehr nutzen.
6. Überprüfen, ob die QR-Bildgenerierung funktioniert und das Handy tatsächlich die verwendete Home-Assistant-Adresse erreicht.
7. Neustart von Home Assistant: Zuordnungen, Aufgaben und Termine weiterhin vorhanden.

**Testversion:** Python- und JS-Syntax und ZIP-Inhalt wurden überprüft, nicht jedoch ein vollständiger Lauf in einer echten Home-Assistant-Instanz. Bitte zunächst mit Testkonten und ohne unnötig sensible Familieninformationen testen.
