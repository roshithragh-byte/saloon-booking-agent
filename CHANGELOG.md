# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-11-26

### Added
- **Aura AI Booking Concierge**: 4-stage sequential booking flow (`Name` -> `Date` -> `Service` -> `Review & Confirm`).
- **Interactive 7-Day Date Picker**: Dynamic native WhatsApp list message offering 7 consecutive booking days.
- **Gender-Filtered Service Catalog**: Interactive WhatsApp menu separating Men's and Ladies' services with Combos and individual treatments.
- **Google Calendar Real-Time Synchronization**: Two-way busy slot detection, dynamic conflict prevention, and direct appointment event creation.
- **Railway PostgreSQL Integration**: Persistent storage for appointments, customer CRM records, and background sync outbox with fail-open fallback.
- **Receptionist CRM Portal**: Web-based dashboard (`/crm`) with Basic Authentication and walk-in appointment creation.
- **Security & Reliability**: Timing-safe HMAC SHA-256 webhook signature validation (`x-hub-signature-256`), deduplication of incoming messages (`processed_webhooks`), and HTML-escaped CRM display.
- **Automated Verification Suite**: Comprehensive test suite covering end-to-end conversation flows, transactional confirmations, and live Google Calendar conflict revalidation.

