# Security Policy

## Supported versions

Security fixes are provided for the latest release on the default branch.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's
private vulnerability reporting feature for this repository. Include affected
versions, reproduction steps, impact, and any suggested remediation.

Please allow maintainers a reasonable amount of time to investigate before
public disclosure.

## Security model

DBDeck is a local desktop application and binds its HTTP service
to loopback addresses only. It is not designed to be exposed on a LAN or the
public internet. Database connections run with the permissions of the
credentials supplied by the user.

Connection passwords, SSH credentials, LLM API keys, saved queries, and query
history are stored in the local `config.db` SQLite database without
application-level encryption. Protect the operating-system account and file,
and do not share configuration exports unless you intend to share their
credentials.

When AI features are used, prompts, schema context, queries, and tool results
may be sent to the configured LLM provider. Review that provider's data policy
before using AI features with sensitive databases.
