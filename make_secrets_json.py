import json
import re
import sys

ENV_FILE = sys.argv[1] if len(sys.argv) > 1 else ".env.prod"

# KeyVaultSecretName -> EnvVarName
MAP = {
  "MONGODBURI": "MONGODB_URI",
  "JWTSECRET": "JWT_SECRET",
  "JWTREFRESHSECRET": "JWT_REFRESH_SECRET",
  "ENCRYPTIONKEY": "ENCRYPTION_KEY",
  "EMAILUSER": "EMAIL_USER",
  "EMAILPASS": "EMAIL_PASS",
  "EMAILHOST": "EMAIL_HOST",
  "EMAILPORT": "EMAIL_PORT",
  "EMAILFROMNAME": "EMAIL_FROM_NAME",
  "EMAILFROMADDRESS": "EMAIL_FROM_ADDRESS",
  "AZURESTORAGECONNECTIONSTRING": "AZURE_STORAGE_CONNECTION_STRING",
  "AZURESTORAGECONTAINER": "AZURE_STORAGE_CONTAINER",
  "AZURESERVICEBUSCONNECTIONSTRING": "AZURE_SERVICE_BUS_CONNECTION_STRING",
  "AZUREMONITORCONNECTIONSTRING": "AZURE_MONITOR_CONNECTION_STRING",
  "REDISCONNECTIONSTRING": "REDIS_CONNECTION_STRING",
  "FRONTENDURL": "FRONTEND_URL",
  "APPNAME": "APP_NAME",
  "BASEURL": "BASE_URL",
  "CLEANDATABASE": "CLEAN_DATABASE",
  "SYSTEMADMINEMAIL": "SYSTEM_ADMIN_EMAIL",
  "SYSTEMADMINPASSWORD": "SYSTEM_ADMIN_PASSWORD",
  "SYSTEMADMINTEMPPASSWORD": "SYSTEM_ADMIN_TEMP_PASSWORD",
  "SYSTEMADMINFIRSTNAME": "SYSTEM_ADMIN_FIRST_NAME",
  "SYSTEMADMINLASTNAME": "SYSTEM_ADMIN_LAST_NAME",
}

def strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1]
    return s

env = {}
with open(ENV_FILE, "r", encoding="utf-8") as f:
    for raw in f:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].lstrip()
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        env[k] = strip_quotes(v)

out = {}
missing = []
empty = []
for kv_name, env_key in MAP.items():
    if env_key not in env:
        missing.append(env_key)
        continue
    if env[env_key] == "":
        empty.append(env_key)
        continue
    out[kv_name] = env[env_key]

print(json.dumps(out, indent=2))

if missing or empty:
    print("\n---", file=sys.stderr)
    if missing:
        print("Missing in .env.prod:", ", ".join(missing), file=sys.stderr)
    if empty:
        print("Empty in .env.prod:", ", ".join(empty), file=sys.stderr)