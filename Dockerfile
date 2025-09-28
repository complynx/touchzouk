# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

# Copy static site content to the default nginx public folder
COPY site /usr/share/nginx/html

# Set permissions for non-root usage and cache-busting updates
RUN chown -R nginx:nginx /usr/share/nginx/html

USER nginx

EXPOSE 80

# Nginx provided by base image as default CMD
