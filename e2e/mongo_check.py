"""Lector/mutador mínimo de la base del banco para `e2e/probe.mjs` (JSON por stdin).

    {"col": "payment_links", "id": "<oid>"}       → el documento (o null)
    {"op": "bump_token_version", "user": "<oid>"} → invalida los JWT de usuario vivos
    {"op": "revoke", "credential": "<oid>"}       → revoca una llave sk- (ApiCredential)
"""
import json
import os
import sys

from bson import ObjectId, json_util
from pymongo import MongoClient

url, name = os.environ["MONGODB_URL"], os.environ["MONGODB_DB_NAME"]
if "127.0.0.1" not in url or "e2e" not in name:
    raise SystemExit("NEGATIVA: sólo contra el banco local.")
db = MongoClient(url, directConnection=True)[name]
q = json.loads(sys.stdin.read())
if q.get("op") == "bump_token_version":
    db.User.update_one({"_id": ObjectId(q["user"])}, {"$inc": {"token_version": 1}})
    print("{}")
elif q.get("op") == "revoke":
    db.ApiCredential.update_one({"_id": ObjectId(q["credential"])}, {"$set": {"status": "disabled"}})
    print("{}")
else:
    print(json_util.dumps(db[q["col"]].find_one({"_id": ObjectId(q["id"])})))
