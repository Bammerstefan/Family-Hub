"""Verify genuine BamLabs License Manager v0.4.x Ed25519 Family Hub tokens.

A public key fetched from the official BamLabs site via TLS is pinned on the
first successful activation. The signing private key NEVER leaves WordPress.
"""
from __future__ import annotations
import base64
import json
import re
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

LICENSE_SERVER = "https://bamlabs.at"
PUBLIC_KEY_PATH = "/wp-json/bamlabs/v1/public-key"
STATUS_PATH = "/wp-json/bamlabs/v1/license-status/"
VALID_MODULES = frozenset({"family_pro", "kids_pro", "school_pro"})
ALL_MODULES = frozenset(VALID_MODULES)
GRACE_SECONDS = 14 * 86400
CHECK_SECONDS = 6 * 3600


def _decode(part: str) -> bytes:
    if not isinstance(part, str) or not 1 <= len(part) <= 8192 or not re.fullmatch(r"[A-Za-z0-9_-]+", part):
        raise ValueError("Ungültige Lizenzkodierung")
    try:
        return base64.b64decode(part.translate(str.maketrans("-_", "+/")) + "=" * (-len(part) % 4), validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError("Ungültige Lizenzkodierung") from exc


def validate_certificate(token: str, installation_id: str, public_key_b64: str) -> dict:
    if not public_key_b64:
        raise ValueError("Öffentlicher BamLabs-Prüfschlüssel fehlt")
    if not isinstance(token, str) or len(token) > 8192:
        raise ValueError("Ungültiger Lizenzschlüssel")
    sections = token.strip().split(".")
    if len(sections) != 2:
        raise ValueError("Ungültiges Lizenzformat")
    payload_bytes, signature = _decode(sections[0]), _decode(sections[1])
    try:
        key = base64.b64decode(public_key_b64, validate=True)
        if len(key) != 32 or len(signature) != 64:
            raise ValueError("Ungültige Schlüssellänge")
        Ed25519PublicKey.from_public_bytes(key).verify(signature, payload_bytes)
    except (InvalidSignature, ValueError) as exc:
        raise ValueError("Lizenzsignatur ungültig") from exc
    try:
        data = json.loads(payload_bytes)
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("Lizenzdaten ungültig") from exc
    if not isinstance(data, dict) or data.get("schema") != 1 or data.get("product") != "family_hub" or data.get("perpetual") is not True:
        raise ValueError("Keine gültige Family-Hub-Lizenz")
    if data.get("installation_id") != installation_id:
        raise ValueError("Lizenz gehört zu einer anderen Home-Assistant-Installation")
    if not isinstance(data.get("license_id"), str) or not re.fullmatch(r"[a-f0-9-]{36}", data["license_id"]):
        raise ValueError("Ungültige Lizenzkennung")
    modules = data.get("modules")
    if not isinstance(modules, list) or not modules or any(not isinstance(m, str) or m not in VALID_MODULES for m in modules) or len(set(modules)) != len(modules):
        raise ValueError("Unbekannte Family-Hub-Module")
    return {"license_id": data["license_id"], "modules": sorted(modules), "product": "family_hub"}
