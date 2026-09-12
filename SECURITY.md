# Security

Nebulaw-Ontology Pilot is an experimental project. It does not provide a production security guarantee, SLA, or public incident-response service. Run it with synthetic or isolated data until an independent deployment review is complete.

## Do not commit

- credentials, tokens, private keys, or passwords;
- customer data, private datasets, or model weights;
- deployment files, logs, database snapshots, or internal infrastructure details;
- absolute local paths or remote connection configuration.

If sensitive material is exposed, rotate or revoke it first, then remove it from the working tree and review Git history. Adding a file to .gitignore does not remove previously committed content.

## Reporting

This repository does not yet have a dedicated public security response channel. For a suspected issue, contact the maintainer privately at **yangjiakang@nebulaw.ai** with a minimal reproduction and avoid including secrets or customer data.

The upstream platform/SECURITY.md describes the upstream platform scope. It does not transfer security responsibility for the additions in this repository.
