# Security policy

[فارسی](docs/security.fa.md)

Security fixes target the latest source release, currently 3.7.7. No response-time guarantee or independent security certification is claimed.

Do not post credentials, private content, browser profiles or a working exploit against another person's system in a public issue. After a public repository is established, use its **Security → Report a vulnerability** facility if the maintainer enables private reporting. Otherwise contact the maintainer privately through a verified channel; this distribution has no invented security mailbox. Ordinary non-sensitive bugs can use the issue template.

Include the affected version, operating system/browser, affected component, minimal reproduction using synthetic data, impact and any proposed fix. Redact authorization headers, query credentials, bridge tokens and file paths. If a real key or token was exposed, revoke/rotate it at its issuer; deleting a committed file alone does not revoke it.

The extension isolates page UI where possible, checks worker inputs and uses a loopback companion with token/origin checks. These controls do not make untrusted providers, downloaded models, Python packages or external manga applications safe by themselves. Select providers you trust. Do not bind or forward the bridge to public interfaces. Public-source and package checks are pattern-based checks, not proof of the absence of every possible secret or vulnerability.

Supply-chain updates should review the lockfile and third-party licenses, run regressions and inspect the public allowlist before distribution. CI has read-only repository permissions and no release-upload credentials.
