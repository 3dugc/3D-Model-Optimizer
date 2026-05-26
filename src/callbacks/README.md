# Callback Delivery

This directory is reserved for signed customer callback delivery.

Planned responsibilities:

- Build callback payloads for job terminal events.
- Sign callbacks with tenant callback secrets.
- Send callbacks with timeouts.
- Retry failed callbacks with exponential backoff.
- Store delivery attempts and allow manual replay.
