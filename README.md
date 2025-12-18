# Rakutore Anchor – Backend Specification

## Overview
Rakutore Anchor is a subscription-based MT4 EA.
License control and file distribution are handled via Stripe Webhooks and Supabase.

---

## Stripe Event Handling

### checkout.session.completed
**Purpose:** Initial purchase handling

Actions:
- Create or initialize license
- Generate one-time download URL
- Send download email to customer

Notes:
- File distribution happens ONLY here

---

### invoice.paid
**Purpose:** Subscription continuation

Actions:
- Mark license as active
- Extend expiration date if provided

Notes:
- No file distribution
- No email sending
- Price ID may be missing (normal behavior)
- Must never throw errors

---

## License (Supabase)

The `licenses` table is the single source of truth.

Fields:
- customerId
- email
- status (active / inactive)
- expiresAt
- planType (trial / paid)

All validation is based on this table.

---

## Important Rules

- Never throw inside Stripe Webhooks
- Assume missing fields in Stripe payloads
- checkout = distribution
- invoice = continuation

---

## Deployment Notes

- Hosted on Railway
- Node.js v20+
- Stripe Webhooks may retry events automatically

