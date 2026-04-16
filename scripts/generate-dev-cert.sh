#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${ROOT_DIR}/certs/dev"
CA_KEY="${CERT_DIR}/local-ca.key.pem"
CA_CERT="${CERT_DIR}/local-ca.cert.pem"
SERVER_KEY="${CERT_DIR}/web.key.pem"
SERVER_CSR="${CERT_DIR}/web.csr.pem"
SERVER_CERT="${CERT_DIR}/web.cert.pem"
OPENSSL_CONFIG="${CERT_DIR}/openssl.cnf"
HOST_IP="${1:-}"
HOST_NAME="${2:-macmini.local}"

if [[ -z "${HOST_IP}" ]]; then
  if command -v ipconfig >/dev/null 2>&1; then
    HOST_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
    if [[ -z "${HOST_IP}" ]]; then
      HOST_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
    fi
  fi
fi

if [[ -z "${HOST_IP}" ]]; then
  echo "Unable to detect LAN IP automatically. Usage: $0 <lan-ip> [hostname]" >&2
  exit 1
fi

mkdir -p "${CERT_DIR}"

cat > "${OPENSSL_CONFIG}" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
CN = ${HOST_NAME}
O = Remote Camera AI Dev

[req_ext]
subjectAltName = @alt_names
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = ${HOST_NAME}
IP.1 = ${HOST_IP}
IP.2 = 127.0.0.1
EOF

if [[ ! -f "${CA_KEY}" || ! -f "${CA_CERT}" ]]; then
  openssl genrsa -out "${CA_KEY}" 4096
  openssl req \
    -x509 \
    -new \
    -nodes \
    -key "${CA_KEY}" \
    -sha256 \
    -days 3650 \
    -out "${CA_CERT}" \
    -subj "/CN=Remote Camera AI Dev Root CA/O=Remote Camera AI Dev"
fi

openssl genrsa -out "${SERVER_KEY}" 2048
openssl req \
  -new \
  -key "${SERVER_KEY}" \
  -out "${SERVER_CSR}" \
  -config "${OPENSSL_CONFIG}"

openssl x509 \
  -req \
  -in "${SERVER_CSR}" \
  -CA "${CA_CERT}" \
  -CAkey "${CA_KEY}" \
  -CAcreateserial \
  -out "${SERVER_CERT}" \
  -days 825 \
  -sha256 \
  -extensions req_ext \
  -extfile "${OPENSSL_CONFIG}"

rm -f "${SERVER_CSR}" "${CERT_DIR}/local-ca.cert.srl"

echo "Generated dev certificates:"
echo "  CA cert:     ${CA_CERT}"
echo "  Server cert: ${SERVER_CERT}"
echo "  Server key:  ${SERVER_KEY}"
echo
echo "Next steps:"
echo "  1. Trust ${CA_CERT} on your Android device."
echo "  2. Restart docker compose so HTTPS serves ${HOST_IP} / ${HOST_NAME}."
