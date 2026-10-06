Throwaway keys for the auth crate's tests only (generated with openssl for this repository).
They sign mock Google/Apple id_tokens (`rsa_test_*`, `rsa_other_*` = a key that is not in the
mock JWKS) and Apple client secrets (`ec_test_*`, P-256). `*_n.txt` / `ec_test_x|y.txt` are the
public JWK components. Never use them anywhere else.
