# seatgate

`seatgate` is the blocking function that runs before every account is created in the Firebase project (measure A). It lives here, outside Netlify, because Identity Platform calls it directly. The proofs of 19 and 23 November 2026 are in the project doc `claude/Brigvanti-B2B-MeasureA-Proof-Results.md`.

**It runs for every sign-up, B2C included.** A consumer sign-up returns at once, without loading anything. A fault in a company tenant refuses that company sign-up and never lets a stranger in. Never deploy to live without Robbie's approval.

## Rules

| Sign-up | Result |
|---|---|
| No tenant (B2C) | Passes, 0 ms, nothing read |
| Company tenant, method `password` | Refused, nothing read |
| No company for the tenant, or two | Refused |
| Contract not running | Refused |
| `signIn` not set on the company | Refused |
| Sign-in method is not the company's `signIn` | Refused |
| `signIn: 'microsoft'` and the Microsoft tenant (`tid`) is not `microsoftTenantId` | Refused, before the seat list is read |
| An admin record for the address | Passes |
| A seat that is `invited` or `active` | Passes |
| Anything else, or the database takes longer than 4 seconds | Refused |

The logic is in `seatgate/core.mjs`, tested by `node tool/test-b2b.mjs`. `seatgate/index.js` is the Cloud Function around it.

## Company fields seatgate needs

| Field | Values |
|---|---|
| `tenantId` | The Identity Platform tenant ID |
| `signIn` | `microsoft`, `google`, `emailLink`, `saml` or `oidc` |
| `microsoftTenantId` | The company's Microsoft tenant ID, only with `signIn: 'microsoft'` |
| `contractStart`, `contractEnd` | Already part of every company record |

## Deploy settings

| File | Purpose |
|---|---|
| `firebase.json` | Deploys `seatgate/` as codebase `seatgate`, Node 22, region europe-west1 |
| `.firebaserc` | Aliases `proof` (brigvanti-tenant-proof) and `live` (brigvanti-academy). There is no default, so every command must name the project. |
| `seatgate/.env.brigvanti-tenant-proof` | The test project keeps its data in `(default)`. Live uses the named database `brigvanti`. |

## 1. Test run in brigvanti-tenant-proof

Run this before any live deploy. It proves the packaged function, not only the logic.

1. Firebase console of the test project > Project settings > Service accounts > **Generate new private key**. Save it as `~/proof-key.json`.
2. In the terminal, type each line by hand:

   ```bash
   cd ~/brigvanti-academy && git fetch origin && git checkout claude/b2b-seatgate && git pull
   cd gcp/seatgate && npm install && cd ..
   npx firebase-tools@15 deploy --only functions --project proof
   ```

   After the PR is merged, use `git checkout main && git pull` instead of the first line.

3. Firebase console > Authentication > Settings > **Blocking functions**. Before account creation must show `seatgate`. Before sign in stays None.
4. Seed a company with email link and one admin:

   ```bash
   cd ~/brigvanti-academy/gcp/seatgate
   export GOOGLE_APPLICATION_CREDENTIALS=$HOME/proof-key.json
   export TENANT_ID=TheNinthTee-058gd
   export SIGN_IN=emailLink
   export SEATS="support@theninthtee.eu"
   export ADMINS="rpadehaas@gmail.com"
   node proof-seed.mjs seed
   ```

5. Run the tests below with the test page of the `measure-a-link` kit. Hosting is disabled, so deploy it again from `~/measure-a-link` with `npx firebase-tools@15 deploy --only hosting --project brigvanti-tenant-proof`. **Do not deploy functions from that kit**, because it would replace this `seatgate` with the proof version.

   | # | Test | Expected reason in the log |
   |---|---|---|
   | S1 | Email link for `support@theninthtee.eu` | `seat_pass` |
   | S2 | Email link for `rpadehaas@gmail.com`, the admin without a seat | `admin_pass` |
   | S3 | Password sign-up for any address | `password_signup` |
   | S4 | Email link for an address on neither list | `not_on_seat_list` |
   | S5 | A consumer sign-up without a tenant, with the command below | `consumer_pass` |

   For S5, type this line by hand. Replace `YOUR-KEY` with the Web API key of the test project. It must print the test address.

   ```bash
   curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=YOUR-KEY" -H "content-type: application/json" -d '{"email":"consumer-test@theninthtee.eu","password":"Consumer-test-1","returnSecureToken":true}' | grep -o '"email": *"[^"]*"'
   ```

6. Read the log:

   ```bash
   npx firebase-tools@15 functions:log --only seatgate --project proof 2>&1 | grep result | tail -10
   ```

7. Clean up: `node proof-seed.mjs clean`, then `npx firebase-tools@15 functions:delete seatgate --region europe-west1 --project proof`, then `npx firebase-tools@15 hosting:disable --project brigvanti-tenant-proof`. Check that Blocking functions is empty. Delete `consumer-test@theninthtee.eu` under Firebase console > Authentication > Users, which shows the project users without a tenant. Delete the service account key in the console and run `rm ~/proof-key.json`.

The Microsoft tenant check (`microsoft_tenant_*`) needs a separate run with `SIGN_IN=microsoft`, a new client secret in Entra and the `measure-a-sso` kit. It must pass before the first Microsoft company, not before the live deploy.

## 2. Live deploy, only with Robbie's approval

**Decided 26 November 2026:** the live project is upgraded to Identity Platform and `seatgate` is deployed in one session, shortly before the first company. Until then B2C stays untouched. On live, `seatgate` refuses every company sign-up until a company record exists, and B2C sign-ups pass.

**Before the deploy**

1. **Identity Platform upgrade.** Firebase console of `brigvanti-academy` > Authentication. On 26 November 2026 the title read only "Authentication", so live is not upgraded yet. Blocking functions and tenants need the upgrade. Treat it as one-way: Google does not document a way back. Google states that apps keep working without changes. Cost: free up to 50,000 monthly active users for email, Google and Microsoft sign-in. SAML and OIDC are free up to 50 monthly active users per project, then $0.015 each. Upgrade under Authentication > Settings, then check that the title reads **Authentication with Identity Platform**.
2. **Compute account and roles.** Done on 26 November 2026. The Compute Engine API was switched on, which created `951390386116-compute@developer.gserviceaccount.com`, and it holds **Cloud Build Service Account** and **Cloud Datastore User**. Check under IAM & Admin > IAM that both roles are still there. Never let the first deploy create this account itself: in the test project, that first deploy failed on the missing roles.
3. Have a new test address ready for a B2C sign-up, one that has never signed up before.
4. Plan a full B2C regression pass right after the upgrade, before the deploy: sign up, sign in, password reset, Delete my account, on 375 px and 1280 px.

**Deploy**

```bash
cd ~/brigvanti-academy/gcp/seatgate && npm install && cd ..
npx firebase-tools@15 deploy --only functions --project live
```

**Right after the deploy**

1. Firebase console > Authentication > Settings > Blocking functions: Before account creation shows `seatgate`, Before sign in shows None.
2. Sign up on the live app with the new test address. The sign-up must work as before.
3. `npx firebase-tools@15 functions:log --only seatgate --project live 2>&1 | grep result | tail -5` must show `consumer_pass`.
4. Sign in with an existing B2C account. It must work. Signing in never runs `seatgate`.
5. Delete the test account through Delete my account.

**Rollback**

If a B2C sign-up fails after the deploy:

```bash
npx firebase-tools@15 functions:delete seatgate --region europe-west1 --project live
```

Then check that Blocking functions is empty. B2C sign-up works again at once.

## Known limits

- A consumer sign-up pays the cold start of the function, up to about 1 second extra. A warm instance adds about 100 to 200 ms. `minInstances: 1` would remove the cold start at a small monthly cost. Not set.
- If the function cannot load Google credentials, the database library throws outside any promise and the instance stops. On live the function runs with its own service account, so this does not occur. The 4-second limit covers a slow or unreachable database.
- Microsoft: the seat list must hold the employee's Microsoft sign-in name.
- `seatgate` only runs at account creation. Signing in to an existing account never runs it. An ended seat keeps read access for 30 days, and the coach block sits in the entitlement (PR #30).
