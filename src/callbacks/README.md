# Callback Delivery

This directory implements signed customer callback delivery.

Current responsibilities:

- Build callback payloads for job terminal events.
- Resolve server-managed signing secrets by `callbackSecretId` and sign payloads.
- Send callbacks with timeouts.
- Reject unsafe/private callback destinations and HTTP redirects.
- Retry transient failures with bounded exponential backoff.

Still planned:

- Persist delivery attempts so retries survive process restarts.
- Provide delivery query and manual replay APIs.
