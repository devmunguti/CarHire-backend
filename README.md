# Gari Poa backend

The backend is the Express 5 API for Gari Poa. MongoDB with Mongoose is the persistence layer; migrations are managed with `migrate-mongo`. Do not commit `.env` values.

## Local setup

1. Use Node.js 20.19 or newer, then install dependencies with `npm install`.
2. Copy `.env.example` to `.env`, set a private `ACCESS_TOKEN_SECRET` of at least 32 characters, and point `MONGODB_URI` at MongoDB configured as a replica set. Fleet reservation and maintenance writes use transactions; standalone MongoDB is not supported for those operations.
3. Apply migrations with `npm run db:migrate`.
4. Provision the first owner with `npm run owner:create`. This command requires an interactive terminal, only works when no owner exists, and does not echo the password.
5. Configure SMTP values to deliver invitations and password-reset links. Without SMTP, invitation operations return an explicit delivery error; password-reset requests still return a generic acknowledgement to prevent account enumeration and log delivery failures.
6. To enable fleet vehicle image uploads, set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in `.env` using values from your Cloudinary console. All three are required together. Uploads are restricted to JPEG, PNG, and WebP files up to 5 MiB; the backend stores the secure CDN URL on the vehicle.
7. To enable online M-Pesa checkout through PayHero, set `PAYHERO_USERNAME`, `PAYHERO_PASSWORD`, `PAYHERO_CHANNEL_ID`, and `PAYHERO_CALLBACK_URL` to `https://<your-api-host>/api/v1/webhooks/payhero`. Set all four together. The callback is verified against PayHero's transaction-status endpoint. Without complete configuration, online payment returns an explicit provider-unavailable error; offline cash approval remains a separate staff workflow.
8. Start the API with `npm run dev`. Health is available at `http://localhost:4000/api/v1/health`.

The access JWT expires after 15 minutes. A refresh cookie is HttpOnly, SameSite=Lax, path-scoped to `/api/v1/auth`, and expires 30 days after the session is created. Refresh rotates the opaque token; its hash is stored server-side. Production cookies use Secure.

## Real-auth frontend development

The current MSW worker is all-or-nothing. It cannot mock non-auth routes while passing auth routes through. To use the real API, set `VITE_USE_MOCKS=false` and `VITE_API_BASE_URL=http://localhost:4000/api/v1` in `Frontend/.env.local`, then start Vite on `http://localhost:5173`. The backend allows that origin (and `http://127.0.0.1:5173`) with credentials. Keep the frontend and API on the same host name (`localhost` with `localhost`); refresh cookies are not shared across `localhost` and `127.0.0.1`.

Health, authentication and staff account lifecycle, Cloudinary-backed vehicle images, maintenance windows, authoritative quotes, staff and guest booking holds, guest checkout, PayHero payment initiation/status/callback verification, refunds, handover inspections, driver trips, incident dispatch/resolution, rental extensions, dashboard, notifications, search, approvals, and audit APIs are implemented. The full backend test suite runs against an in-memory MongoDB replica set; deployed Atlas, Cloudinary, SMTP, and PayHero credentials and callback reachability still require environment-specific verification. Route guards are UX only; API permissions are enforced server-side.

## Verification

- `npm test` runs the Node built-in test runner.
- `npm run db:migrate` applies pending schema/index migrations.
- `npm run db:rollback` rolls back the most recent migration.
- The MongoDB integration tests use a single-node in-memory replica set to exercise transactions and overlapping-reservation contention.
