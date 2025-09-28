# touchzouk
All for my DJ site

## Containerized static site

This repository ships with a minimal container image based on `nginx:alpine` that serves the contents of the `site/` directory. The image exposes port `80` and can be attached to Traefik or any reverse proxy.

### Build the image

```bash
docker build -t touchzouk-site .
```

### Run locally

```bash
docker run --rm -p 8080:80 touchzouk-site
```

Visit <http://localhost:8080> to verify the site before wiring it into Traefik.
