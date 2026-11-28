# Demo deploy through Cloudflare Tunnel

`scripts/deploy-demo.sh` brings up the compose stack (`infra/docker-compose.yml` plus the
overlay `infra/docker-compose.cloudflare.yml`) and a `cloudflared` connector. Every service
container is limited to 256 MB; PostgreSQL 512 MB, Redis and NATS 128 MB, cloudflared 128 MB.
Published ports are bound to `127.0.0.1`, so the tunnel is the only way in from outside.

## Usage

```
DEPLOY_TARGET=this_server scripts/deploy-demo.sh --check   # validate only, no containers
DEPLOY_TARGET=this_server scripts/deploy-demo.sh           # build, start, print the address
```

Values come from the environment, falling back to the local setup file. Only the names of
missing values are ever printed.

| DEPLOY_TARGET | Behavior                                                   |
| ------------- | ---------------------------------------------------------- |
| `this_server` | validate the setup file, then deploy                           |
| `none`/unset  | skip the real deploy, exit 0 (verify locally instead)      |
| other         | exit 2                                                     |

Required for `this_server`: `DOMAIN`, `CLOUDFLARE_TUNNEL_TOKEN`, `SESSION_SECRET`,
`APP_ENCRYPTION_KEY`, `ADMIN_EMAIL`. Optional: `APP_SUBDOMAIN` (default `mywife`).
The address is `https://<APP_SUBDOMAIN>.<DOMAIN>`.

## Owner actions (done only by the owner)

1. Create the tunnel and a public hostname `<APP_SUBDOMAIN>.<DOMAIN>` routing to `http://web:3100`.
2. Put the tunnel connector token into the setup file as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Run the deploy command.

Test offline with `pnpm test:scripts`.
