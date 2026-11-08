# v0.3.14 – Handy-Benachrichtigungen

- Optionaler Push-Versand über die Home-Assistant-Companion-App an ausgewählte Handys.
- Pro Familienmitglied eigene Handy-Zuordnung unter Einstellungen.
- Jede Person erhält nur ihre eigenen offenen, fälligen bzw. überfälligen Aufgaben.
- Maximal eine automatische Nachricht pro Mitglied und Tag bei der eingestellten Uhrzeit.
- Testnachricht für jedes Mitglied, unabhängig von fälligen Aufgaben.
- Push-Funktion standardmäßig deaktiviert. Home-Assistant-Benachrichtigungen bleiben bestehen.

**Voraussetzung:** Offizielle Home-Assistant-App verbunden, Benachrichtigungen erlaubt; `notify.mobile_app_…`-Dienst vorhanden.
**Hinweis:** Ein erfolgreich aufgerufener Dienst garantiert nicht, dass das Betriebssystem die Nachricht tatsächlich anzeigt.
