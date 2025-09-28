# syntax=docker/dockerfile:1
FROM nginx:alpine

# Copy static site content to the default nginx public folder
COPY site /usr/share/nginx/html

# Set permissions and writable dirs for non-root usage
RUN mkdir -p /var/cache/nginx /var/run /var/log/nginx /run \
	&& touch /var/run/nginx.pid \
	&& chown -R nginx:nginx \
		/usr/share/nginx/html \
		/var/cache/nginx \
		/var/run \
		/run \
		/var/log/nginx

USER nginx

EXPOSE 80

# Nginx provided by base image as default CMD
