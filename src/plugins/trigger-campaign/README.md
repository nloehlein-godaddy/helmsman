# Campaign trigger

This backend-only package registers `helmsman.trigger-campaign/dispatch`. It chooses the first eligible campaign candidate from the bounded core projection, preserving the existing FIFO policy. Helmsman owns eligibility, claiming, dispatch, launch identity, and provenance.

The provider has no timers, credentials, persistence, private imports, or launch authority.
