This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## SaaS tenant seed

The app requires `DATABASE_URL` and `SESSION_SECRET` for login and tenant routing.
Create the default local account:

```bash
bun run seed:saas
```

Default login:

```text
account: demo
password: demo123456
tenant: tenant_demo
```

You can override the seed with environment variables:

```bash
SAAS_SEED_ACCOUNT=admin SAAS_SEED_PASSWORD=change-me bun run seed:saas
```

To generate only a password hash:

```bash
bun run hash-password demo123456
```

Manual SQL seed example:

```sql
INSERT INTO public.saas_tenants (hash_id, name, status, expires_at)
VALUES
  ('tenant_demo', 'Demo Tenant', 'trial', NOW() + INTERVAL '14 days'),
  ('tenant_expired', 'Expired Tenant', 'expired', NOW() - INTERVAL '1 day')
ON CONFLICT (hash_id) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status,
    expires_at = EXCLUDED.expires_at,
    updated_at = NOW();

INSERT INTO public.saas_users (
  hash_id,
  account,
  name,
  nickname,
  password_hash,
  is_active,
  joined_tenant_hash_ids,
  current_tenant_hash_id
)
VALUES (
  'user_demo',
  'demo',
  'Demo User',
  'Demo',
  '<PASSWORD_HASH_FROM_SCRIPT>',
  true,
  ARRAY['tenant_demo', 'tenant_expired'],
  'tenant_demo'
)
ON CONFLICT (account) DO UPDATE
SET name = EXCLUDED.name,
    nickname = EXCLUDED.nickname,
    password_hash = EXCLUDED.password_hash,
    is_active = EXCLUDED.is_active,
    joined_tenant_hash_ids = EXCLUDED.joined_tenant_hash_ids,
    current_tenant_hash_id = EXCLUDED.current_tenant_hash_id,
    updated_at = NOW();
```

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
