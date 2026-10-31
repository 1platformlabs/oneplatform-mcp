"""Semilla del banco local de `/verify-epic-e2e infraestructura-para-agentes-ia`.

Corre con el venv y el código de un worktree de `1platform-api` (la épica no
toca el API: el banco sirve `origin/main`). Cada cuenta existe porque un
criterio de aceptación de IPA-04 la necesita:

    a    dueña del negocio, con saldo, una transacción aprobada que trae número
         de autorización bancaria (CA-2: `redact`), y es la que crea y cancela
         un link por el camino del producto (CA-9).
    b    otra cuenta del MISMO espacio con su propio negocio: con las llaves de
         `a`, el negocio de `b` tiene que dar 404 del API (aislamiento).
    r    cuenta cuya llave se revoca a mitad de la corrida (CA-5: 401 → se
         invalida, se reintenta una vez y el error llega como dato).

Uso (sólo contra el banco; el API ya arrancado, que crea GENERAL_SETTINGS):

    source <banco>/env.sh
    API_ROOT=<worktree api> <venv>/bin/python e2e/seed_bench.py > <banco>/fixture.json
    API_ROOT=<worktree api> <venv>/bin/python e2e/seed_bench.py --teardown

Etiqueta neutra `E2E-IPA-1`.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.environ["API_ROOT"]
sys.path.insert(0, ROOT)

from bson import Decimal128, ObjectId  # noqa: E402
from pymongo import AsyncMongoClient  # noqa: E402

from app.services.api_developer.credential_service import hash_secret  # noqa: E402
from app.utils.encryption import encrypt_value  # noqa: E402

TAG = "E2E-IPA-1"
SLUG = TAG.lower()
NOW = datetime.now(timezone.utc)
CUR = "GTQ"


def _db():
    url, name = os.environ["MONGODB_URL"], os.environ["MONGODB_DB_NAME"]
    if "127.0.0.1" not in url and "localhost" not in url:
        raise SystemExit("NEGATIVA: esta semilla sólo corre contra el banco local.")
    if "e2e" not in name:
        raise SystemExit(f"NEGATIVA: {name!r} no es una base de banco.")
    return AsyncMongoClient(url, directConnection=True)[name]


async def teardown(db) -> None:
    apps = [a["_id"] async for a in db.App.find({"slug": {"$regex": f"^{SLUG}"}}, {"_id": 1})]
    users = [u["_id"] async for u in db.User.find({"app_id": {"$in": apps}}, {"_id": 1})]
    biz = [b["_id"] async for b in db.Business.find({"app_id": {"$in": apps}}, {"_id": 1})]
    for col, flt in (
        ("Transaction", {"user_id": {"$in": users}}),
        ("payment_links", {"app_id": {"$in": apps}}),
        ("Billing", {"user_id": {"$in": users}}),
        ("UserBranch", {"user_id": {"$in": users}}),
        ("Branch", {"business_id": {"$in": biz}}),
        ("Business", {"app_id": {"$in": apps}}),
        ("PaymentGateway", {"slug": {"$regex": f"^{SLUG}"}}),
        ("ApiCredential", {"app_id": {"$in": apps}}),
        ("DashboardConfigs", {"app_id": {"$in": apps}}),
        ("I18nBundles", {"app_id": {"$in": apps}}),
        ("Roles", {"app_id": {"$in": apps}}),
        ("Permissions", {"app_id": {"$in": apps}}),
        ("Website", {"user_id": {"$in": users}}),
        ("User", {"_id": {"$in": users}}),
        ("App", {"_id": {"$in": apps}}),
    ):
        await db[col].delete_many(flt)
    print(f"teardown: {len(apps)} espacios de {TAG}", file=sys.stderr)


async def seed(db) -> dict:
    await teardown(db)
    app_id = ObjectId()
    await db.App.insert_one({
        "_id": app_id, "name": f"{TAG} Espacio", "slug": f"{SLUG}-panel", "status": "active",
        "api_key": f"legacy-{SLUG}-{secrets.token_hex(6)}", "keys": {}, "created_at": NOW,
        "config": {"dashboard": {"enabled": True, "config_version": 1}},
        "branding": {
            "display_name": f"{TAG} Espacio", "from_name": TAG, "from_email": "noreply@example.com",
            "support_email": "support@example.com", "logo_url": "", "color_primary": "#0F172A",
            "color_background": "#FFFFFF", "color_text": "#0F172A", "legal_address": "Banco local",
            "locale": "es", "timezone": "America/Guatemala", "custom_domain_verified": False,
        },
    })
    ak = f"ak-{SLUG}-{secrets.token_hex(16)}"
    await db.ApiCredential.insert_one({
        "_id": ObjectId(), "kind": "app", "app_id": app_id, "name": f"{TAG} app key",
        "token_hash": hash_secret(ak), "prefix": "ak-", "last4": ak[-4:], "status": "active",
        "is_bootstrap": True, "created_at": NOW, "updated_at": NOW,
    })

    gw = ObjectId()
    await db.PaymentGateway.insert_one({
        "_id": gw, "app_id": None, "name": f"{TAG} Pasarela", "slug": f"{SLUG}-gw",
        "provider": "migo", "status": "active", "api_url": "http://127.0.0.1:9", "timeout": 3,
        "settles_to_merchant": False,
        "currencies": [{"currency": CUR, "client": f"{SLUG}-client",
                        "api_key": encrypt_value("e2e-ipa-fake-key"), "is_default": True}],
        "created_at": NOW, "updated_at": NOW,
    })

    out: dict = {"tag": TAG, "app_id": str(app_id), "ak": ak, "users": {}}
    for tag in ("a", "b", "r"):
        uid, bid, biz, branch, cid = ObjectId(), ObjectId(), ObjectId(), ObjectId(), ObjectId()
        sk = f"sk-{SLUG}-{tag}-{secrets.token_hex(16)}"
        await db.User.insert_one({
            "_id": uid, "email": f"{SLUG}-{tag}@example.com", "username": f"{SLUG}-{tag}",
            "api_key": f"sk-legacy-{secrets.token_hex(8)}", "is_active": True, "app_id": app_id,
            "token_version": 1, "impersonation_epoch": 0, "role_ids": [], "skill_ids": [],
            "verified_at": NOW, "theme": {}, "created_at": NOW, "first_name": TAG,
            "last_name": tag.upper(), "billing_id": bid,
        })
        await db.ApiCredential.insert_one({
            "_id": cid, "kind": "user", "app_id": app_id, "user_id": uid, "name": f"{TAG} {tag}",
            "token_hash": hash_secret(sk), "prefix": "sk-", "last4": sk[-4:], "status": "active",
            "created_at": NOW, "updated_at": NOW,
        })
        await db.Billing.insert_one({
            "_id": bid, "user_id": uid, "balance": Decimal128("125.50"),
            "reserved_balance": Decimal128("0.00"), "currency": CUR,
            "withdrawable_balance": Decimal128("0.00"), "withdrawable_seq": 0,
            "payment_gateway_id": gw, "created_at": NOW, "updated_at": NOW,
        })
        await db.Business.insert_one({
            "_id": biz, "name": f"{TAG} Negocio {tag.upper()}", "documentType": "NIT",
            "documentNumber": f"{secrets.randbelow(10**8):08d}-K", "address": "Banco local",
            "status": "active", "app_id": app_id, "currency": CUR, "settlement_billing_id": bid,
            "default_branch_id": branch, "created_at": NOW, "updated_at": NOW,
        })
        await db.Branch.insert_one({
            "_id": branch, "business_id": biz, "name": f"{TAG} Sucursal {tag.upper()}",
            "commerceId": f"{SLUG}-{tag}", "status": "active", "created_at": NOW, "updated_at": NOW,
        })
        await db.UserBranch.insert_one({
            "_id": ObjectId(), "user_id": uid, "branch_id": branch, "role": "admin", "assigned_at": NOW,
        })
        out["users"][tag] = {"id": str(uid), "sk": sk, "credential_id": str(cid),
                             "business_id": str(biz), "billing_id": str(bid)}

    # a · una transacción aprobada con número de autorización (CA-2: redact).
    a = out["users"]["a"]
    tx = ObjectId()
    await db.Transaction.insert_one({
        "_id": tx, "user_id": ObjectId(a["id"]), "billing_id": ObjectId(a["billing_id"]),
        "external_transaction_id": f"{SLUG}-tx-1", "provider": "migo", "amount": 50.0,
        "usd_amount": 50.0, "currency": CUR, "status": "approved", "description": f"{TAG} recarga",
        "metadata": {}, "created_at": NOW, "updated_at": NOW,
        "webhook_attempts": [{"timestamp": NOW, "status": "approved",
                              "raw_payload": {"bankAuthorization": "974490"},
                              "processing_result": "Balance credited successfully"}],
    })
    a["transaction_id"] = str(tx)

    subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "seed_dashboard_config.py"),
         "--app-slug", f"{SLUG}-panel", "--preset", "1platform"],
        check=True, cwd=ROOT, env=os.environ.copy(), stdout=subprocess.DEVNULL,
    )
    return out


async def main() -> None:
    db = _db()
    try:
        if "--teardown" in sys.argv:
            await teardown(db)
            return
        print(json.dumps(await seed(db), indent=2))
    finally:
        await db.client.close()


if __name__ == "__main__":
    asyncio.run(main())
