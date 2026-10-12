#!/bin/sh
# Make the "Novel Companion Local" code-signing certificate in the login keychain, once per Mac.
# It is self-signed and trusted only on this Mac, which is all a local install needs.
set -eu
NAME="Novel Companion Local"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "\"$NAME\" already exists."; exit 0
fi
D=$(mktemp -d)
cat > "$D/ext.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$D/key.pem" -out "$D/cert.pem" -config "$D/ext.cnf" 2>/dev/null
openssl pkcs12 -export -legacy -inkey "$D/key.pem" -in "$D/cert.pem" -out "$D/id.p12" -passout pass:local -name "$NAME"
security import "$D/id.p12" -k ~/Library/Keychains/login.keychain-db -P local -T /usr/bin/codesign -T /usr/bin/security
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$D/cert.pem"
rm -rf "$D"
security find-identity -v -p codesigning | grep "$NAME"
