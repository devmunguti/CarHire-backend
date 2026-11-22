# AutoHire KE backend

The backend is an Express 5 API. MongoDB with Mongoose is the persistence layer; migrations are managed with `migrate-mongo`. Do not commit `.env` values.

## Local setup

1. Use Node.js 20.19 or newer, then install dependencies with `npm install`.
2. Copy `.env.example` to `.env`, set a private `ACCESS_TOKEN_SECRET` of at least 32 characters, and point `MONGODB_URI` at MongoDB configured as a replica set. Fleet reservation and maintenance writes use transactions; standalone MongoDB is not supported for those operations.
3. Apply migrations with `npm run db:migrate`.
4. Provision the first owner with `npm run owner:create`. This command requires an interactive terminal, only works when no owner exists, and does not echo the password.
5. Configure SMTP values to deliver invitations and password-reset links. Without SMTP, invitation operations return an explicit delivery error; password-reset requests still return a generic acknowledgement to prevent account enumeration and log delivery failures.
6. Start the API with `npm run dev`. Health is available at `http://localhost:4000/api/v1/health`.

The access JWT expires after 15 minutes. A refresh cookie is HttpOnly, SameSite=Lax, path-scoped to `/api/v1/auth`, and expires 30 days after the session is created. Refresh rotates the opaque token; its hash is stored server-side. Production cookies use Secure.

## Real-auth frontend development

The current MSW worker is all-or-nothing. It cannot mock non-auth routes while passing auth routes through. To use the real API, set `VITE_USE_MOCKS=false` and `VITE_API_BASE_URL=http://localhost:4000/api/v1` in `Frontend/.env.local`, then start Vite on `http://localhost:5173`. The backend allows that origin (and `http://127.0.0.1:5173`) with credentials. Keep the frontend and API on the same host name (`localhost` with `localhost`); refresh cookies are not shared across `localhost` and `127.0.0.1`.

Health, authentication, staff invitation/account-lifecycle, vehicle CRUD, maintenance windows, authoritative quotes, atomic booking holds, booking list/detail, lazy hold expiry, offline-payment approval, and reserved-hold cancellation are implemented. M-Pesa callbacks, refunds, guest checkout, handover/driver transitions, dashboard, and other domain APIs remain for later phases. The dashboard and Profile page can be used to verify a protected frontend route; route guards are UX only, while API permissions are enforced server-side.

## Verification

- `npm test` runs the Node built-in test runner.
- `npm run db:migrate` applies pending schema/index migrations.
- `npm run db:rollback` rolls back the most recent migration.
- The MongoDB integration tests use a single-node in-memory replica set to exercise transactions and overlapping-reservation contention.
