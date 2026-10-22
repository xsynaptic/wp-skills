<?php
// Required by the local copy's wp-config.php only; never deploy

define( 'DB_NAME', getenv( 'LOCAL_DB_NAME' ) );
define( 'DB_USER', getenv( 'LOCAL_DB_USER' ) );
define( 'DB_PASSWORD', getenv( 'LOCAL_DB_PASSWORD' ) );
define( 'DB_HOST', getenv( 'LOCAL_DB_HOST' ) );

define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', '/var/log/wordpress/debug.log' );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'DISABLE_WP_CRON', true );

// A page cache serves pages rendered under the old theme or PHP; the copy has no Redis or memcached
define( 'WP_CACHE', false );
define( 'WP_REDIS_DISABLED', true );

// The copy serves plain http
define( 'FORCE_SSL_ADMIN', false );

// The copied database holds live third-party credentials; wordpress.org stays reachable for the rehearsal's updates
define( 'WP_HTTP_BLOCK_EXTERNAL', true );
define( 'WP_ACCESSIBLE_HOSTS', 'api.wordpress.org,downloads.wordpress.org' );

// Every PHP service shares one database, so each serves the URL it was reached on
if ( isset( $_SERVER['HTTP_HOST'] ) ) {
	define( 'WP_HOME', 'http://' . $_SERVER['HTTP_HOST'] );
	define( 'WP_SITEURL', 'http://' . $_SERVER['HTTP_HOST'] );
}
