/**
 * Bundled fallback template catalog — a small curated subset of the Dokploy
 * open-source template registry (https://github.com/Dokploy/templates, MIT),
 * baked in so the Templates gallery still works offline / on first run when
 * the registry is unreachable. The live registry always takes precedence.
 *
 * Regenerate by fetching blueprints/<id>/{template.toml,docker-compose.yml}
 * and the matching meta.json entries from the registry.
 */

export type FallbackTemplate = {
  meta: {
    id: string;
    name: string;
    version: string;
    description: string;
    logo: string;
    links: { github?: string; website?: string; docs?: string };
    tags: string[];
  };
  toml: string;
  compose: string;
};

export const FALLBACK_TEMPLATES: FallbackTemplate[] = [
  {
    meta: {"id": "uptime-kuma", "name": "Uptime Kuma", "version": "2.1.0", "description": "Uptime Kuma is a free and open source monitoring tool that allows you to monitor your websites and applications.", "logo": "uptime-kuma.png", "links": {"github": "https://github.com/louislam/uptime-kuma", "website": "https://uptime.kuma.pet/", "docs": "https://github.com/louislam/uptime-kuma/wiki"}, "tags": ["monitoring"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\n\n[config]\nenv = {}\nmounts = []\n\n[[config.domains]]\nserviceName = \"uptime-kuma\"\nport = 3_001\nhost = \"${main_domain}\"\n",
    compose: "version: \"3.8\"\nservices:\n  uptime-kuma:\n    image: louislam/uptime-kuma:2.1.0\n    restart: always\n    volumes:\n      - uptime-kuma-data:/app/data\n      - /var/run/docker.sock:/var/run/docker.sock\n\nvolumes:\n  uptime-kuma-data:\n",
  },
  {
    meta: {"id": "n8n", "name": "n8n", "version": "1.104.0", "description": "n8n is an open source low-code platform for automating workflows and integrations.", "logo": "n8n.png", "links": {"github": "https://github.com/n8n-io/n8n", "website": "https://n8n.io/", "docs": "https://docs.n8n.io/"}, "tags": ["automation"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\n\n[config]\nmounts = []\n\n[[config.domains]]\nserviceName = \"n8n\"\nport = 5_678\nhost = \"${main_domain}\"\n\n[config.env]\nN8N_HOST = \"${main_domain}\"\nN8N_PORT = \"5678\"\nGENERIC_TIMEZONE = \"Europe/Berlin\"\n",
    compose: "version: \"3.8\"\nservices:\n  n8n:\n    image: docker.n8n.io/n8nio/n8n:1.104.0\n    restart: always\n    environment:\n      - N8N_HOST=${N8N_HOST}\n      - N8N_PORT=${N8N_PORT}\n      - N8N_PROTOCOL=http\n      - NODE_ENV=production\n      - WEBHOOK_URL=https://${N8N_HOST}/\n      - GENERIC_TIMEZONE=${GENERIC_TIMEZONE}\n      - N8N_SECURE_COOKIE=false\n    volumes:\n      - n8n_data:/home/node/.n8n\n\nvolumes:\n  n8n_data:\n",
  },
  {
    meta: {"id": "wordpress", "name": "Wordpress", "version": "latest", "description": "Wordpress is a free and open source content management system (CMS) for publishing and managing websites.", "logo": "wordpress.png", "links": {"github": "https://github.com/WordPress/WordPress", "website": "https://wordpress.org/", "docs": "https://wordpress.org/documentation/"}, "tags": ["cms"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\ndb_name = \"wordpress\"\ndb_user = \"wordpress\"\ndb_password = \"${password:32}\"\n\n[config]\nenv = [\n  \"WORDPRESS_DEBUG=0\",\n  \"DB_NAME=${db_name}\",\n  \"DB_USER=${db_user}\",\n  \"DB_PASSWORD=${db_password}\"\n]\n\n[[config.domains]]\nserviceName = \"wordpress\"\nport = 80\nhost = \"${main_domain}\"\n\n[[config.mounts]]\nfilePath = \"uploads.ini\"\ncontent = \"\"\"upload_max_filesize = 64M\npost_max_size = 64M\nmemory_limit = 256M\nmax_execution_time = 300\nmax_input_vars = 3000\n\"\"\" ",
    compose: "services:\n  wordpress:\n    image: wordpress:latest\n    volumes:\n      - wp_app:/var/www/html\n      - ../files/uploads.ini:/usr/local/etc/php/conf.d/uploads.ini\n    environment:\n      WORDPRESS_DB_HOST: wp_db\n      WORDPRESS_DB_NAME: $DB_NAME\n      WORDPRESS_DB_USER: root\n      WORDPRESS_DB_PASSWORD: $DB_PASSWORD\n      WORDPRESS_DEBUG: ${WORDPRESS_DEBUG:-0}\n      WORDPRESS_CONFIG_EXTRA: |\n        define('WP_MEMORY_LIMIT', '256M');\n        define('DISALLOW_FILE_EDIT', true);\n    depends_on:\n      wp_db:\n        condition: service_healthy\n    restart: unless-stopped\n\n  wp_db:\n    image: mysql:8.4\n    restart: unless-stopped\n    volumes:\n      - wp_data:/var/lib/mysql\n    environment:\n      MYSQL_ROOT_PASSWORD: $DB_PASSWORD\n      MYSQL_DATABASE: $DB_NAME\n    healthcheck:\n      test: [\"CMD-SHELL\", \"exit | mysql -h localhost -P 3306 -u root -p$$MYSQL_ROOT_PASSWORD\"]\n      interval: 10s\n      timeout: 5s\n      retries: 5\n      start_period: 30s\n\nvolumes:\n  wp_app:\n  wp_data:\n",
  },
  {
    meta: {"id": "ghost", "name": "Ghost", "version": "6.0.0", "description": "Ghost is a free and open source, professional publishing platform built on a modern Node.js technology stack.", "logo": "ghost.jpeg", "links": {"github": "https://github.com/TryGhost/Ghost", "website": "https://ghost.org/", "docs": "https://ghost.org/docs/"}, "tags": ["cms"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\n\n[config]\nenv = [\"GHOST_HOST=${main_domain}\"]\nmounts = []\n\n[[config.domains]]\nserviceName = \"ghost\"\nport = 2_368\nhost = \"${main_domain}\"\n",
    compose: "version: \"3.8\"\nservices:\n  ghost:\n    image: ghost:6-alpine\n    restart: always\n    environment:\n      database__client: mysql\n      database__connection__host: db\n      database__connection__user: root\n      database__connection__password: example\n      database__connection__database: ghost\n      url: http://${GHOST_HOST}\n\n    volumes:\n      - ghost:/var/lib/ghost/content\n\n  db:\n    image: mysql:8.0\n    restart: always\n\n    environment:\n      MYSQL_ROOT_PASSWORD: example\n    volumes:\n      - db:/var/lib/mysql\n\nvolumes:\n  ghost:\n  db:\n",
  },
  {
    meta: {"id": "vaultwarden", "name": "Vaultwarden", "version": "1.36.0", "description": "Unofficial Bitwarden compatible server written in Rust, formerly known as bitwarden_rs", "logo": "vaultwarden.svg", "links": {"github": "https://github.com/dani-garcia/vaultwarden", "website": "", "docs": "https://github.com/dani-garcia/vaultwarden/wiki"}, "tags": ["open-source"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\n\n[config]\nmounts = []\n\n[[config.domains]]\nserviceName = \"vaultwarden\"\nport = 80\nhost = \"${main_domain}\"\n\n[config.env]\nSIGNUPS_ALLOWED = \"true\"\nDOMAIN = \"https://${main_domain}\"\n",
    compose: "# the webserver can take a while to start up, so don't be alarmed if it takes a few minutes to get a response\nservices:\n  vaultwarden:\n    image: vaultwarden/server:1.36.0\n    restart: always\n    environment:\n      DOMAIN: ${DOMAIN}\n      SIGNUPS_ALLOWED: ${SIGNUPS_ALLOWED}\n    volumes:\n      - vaultwarden:/data\n    expose:\n      - 80\n\nvolumes:\n  vaultwarden:\n",
  },
  {
    meta: {"id": "minio", "name": "Minio", "version": "latest", "description": "Minio is an open source object storage server compatible with Amazon S3 cloud storage service.", "logo": "minio.png", "links": {"github": "https://github.com/minio/minio", "website": "https://minio.io/", "docs": "https://docs.minio.io/"}, "tags": ["storage"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\napi_domain = \"${domain}\"\n\n[config]\nmounts = []\n\n[[config.domains]]\nserviceName = \"minio\"\nport = 9_001\nhost = \"${main_domain}\"\n\n[config.env]\nMINIO_ROOT_USER = \"minioadmin\"\nMINIO_ROOT_PASSWORD = \"${password:16}\"\nMINIO_BROWSER_REDIRECT_URL = \"http://${main_domain}\"\nMINIO_BROWSER_REDIRECT = \"false\"\n",
    compose: "services:\n  minio:\n    # after RELEASE.2025-04-22T22-12-26Z, minio removed most of the admin UI, if you want to use the admin UI, uncomment the line below\n    # image: minio/minio:RELEASE.2025-04-22T22-12-26Z\n    # if you uncommented the line above, comment the line below\n    image: minio/minio\n    restart: unless-stopped\n    volumes:\n      # by default, the MinIO container will use a volume named minio-data\n      # to store its data. This volume is created automatically by Docker.\n      # If you want to use a local directory instead, uncomment the line below\n      # and specify the path to your local directory.\n      # (be warned that ../files is pointing to a subdirectory of /etc/dokploy/compose in dokploy)\n      # - ../files/minio-data:/data\n      # if you uncommented the line above, comment the line below and the volumes section at the end\n      - minio-data:/data\n    environment:\n      - MINIO_ROOT_USER=${MINIO_ROOT_USER}\n      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}\n      - MINIO_BROWSER_REDIRECT_URL=${MINIO_BROWSER_REDIRECT_URL}\n    command: server /data --console-address \":9001\"\n    ports:\n      # by default, the MinIO container will use port 9000 to expose its API\n      # and port 9001 to expose its web console\n      # minio requires port to be specified when making a request to the API\n      - 9000:9000\n    expose:\n      - 9001\n\n# comment the line below if you specified a local directory in the volumes section of the minio service\nvolumes:\n  minio-data:\n",
  },
  {
    meta: {"id": "portainer", "name": "Portainer", "version": "latest", "description": "Portainer is a container management tool for deploying, troubleshooting, and securing applications across cloud, data centers, and IoT.", "logo": "portainer.png", "links": {"github": "https://github.com/portainer/portainer", "website": "https://www.portainer.io/", "docs": "https://docs.portainer.io/"}, "tags": ["cloud", "monitoring"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\n\n[config]\n[[config.domains]]\nserviceName = \"portainer\"\nport = 9000\nhost = \"${main_domain}\"\n\n[config.env]\n\n[[config.mounts]]",
    compose: "services:\n  portainer:\n    image: portainer/portainer-ce:latest\n    restart: unless-stopped\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - portainer-data:/data\n    ports:\n      - 9000\n\nvolumes:\n  portainer-data: {}",
  },
  {
    meta: {"id": "grafana", "name": "Grafana", "version": "12.4", "description": "Grafana is an open source platform for data visualization and monitoring.", "logo": "grafana.svg", "links": {"github": "https://github.com/grafana/grafana", "website": "https://grafana.com/", "docs": "https://grafana.com/docs/"}, "tags": ["monitoring"]},
    toml: "[variables]\nmain_domain = \"${domain}\"\n\n[config]\nenv = []\nmounts = []\n\n[[config.domains]]\nserviceName = \"grafana\"\nport = 3_000\nhost = \"${main_domain}\"\n",
    compose: "version: \"3.8\"\nservices:\n  grafana:\n    image: grafana/grafana-enterprise:12.4\n    restart: unless-stopped\n    volumes:\n      - grafana-storage:/var/lib/grafana\nvolumes:\n  grafana-storage: {}\n",
  },
];
