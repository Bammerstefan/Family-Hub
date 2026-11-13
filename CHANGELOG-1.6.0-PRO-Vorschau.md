# Family Hub PRO 1.6.0 – Lizenzprüfung (Integration vorbereitet)

- Admin-Maske zum Einfügen und Prüfen signierter Lizenzzertifikate.
- Ed25519-Prüfung offline: Signatur, `product=family_hub_pro`, Installations-ID und Ablaufdatum.
- Keine Aktivierung ohne echten öffentlichen BamLabs-Prüfschlüssel; keine Testschlüssel im Release.
- Lizenzzeichenfolge wird nie an Kinder und nicht in der regulären Admin-Zustandsantwort ausgegeben.
- Entfernen einer zuvor aktivierten Lizenz nur für Home-Assistant-Administratoren.
- Noch **kein** WooCommerce-/BamLabs-License-Manager-Shopadapter, keine Produktfreischaltung im produktiven Sinn.
- Bestehende PRO-Funktionen bleiben Testvorschau; FREE bleibt unverändert.

## Vertrag für künftigen BamLabs License Manager

`token = base64url(payload_bytes) + "." + base64url(ed25519_sign(private_key, payload_bytes))`

Payload als UTF-8 JSON mit `v:1`, `product:"family_hub_pro"`, `installation_id:"..."`, `license_id:"..."` und optional `expires_at` (Unix-Zeitstempel in Sekunden).

**Wichtig**: Nur den *öffentlichen* Ed25519-Schlüssel des echten BamLabs-Shops in `custom_components/bamlabs_family_hub/pro_license.py` als `PRO_PUBLIC_KEY_B64` setzen. Privaten Schlüssel ausschließlich sicher auf dem Shopserver vorhalten. Erst Shop-Plugin und Signaturverfahren abgleichen, bevor echte Kundenlizenzen ausgegeben werden. Der bestehende Meal Planner darf **nicht** als `family_hub_pro` signieren.
