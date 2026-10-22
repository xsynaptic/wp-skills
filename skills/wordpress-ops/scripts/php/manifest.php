<?php
// Runs under `wp --skip-plugins --skip-themes eval-file`: plugin and theme headers are read from disk, never loaded
require_once ABSPATH . 'wp-admin/includes/plugin.php';
global $wpdb;

$active         = array_values( (array) get_option( 'active_plugins', array() ) );
$network_active = is_multisite() ? array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) ) : array();
$all_active     = array_values( array_unique( array_merge( $active, $network_active ) ) );
$installed      = get_plugins();

$plugins = array();
foreach ( $installed as $file => $data ) {
	$plugins[] = array(
		'file'         => $file,
		'name'         => $data['Name'],
		'version'      => $data['Version'],
		'author'       => wp_strip_all_tags( $data['Author'] ),
		'requires_php' => isset( $data['RequiresPHP'] ) ? $data['RequiresPHP'] : '',
		'update_uri'   => isset( $data['UpdateURI'] ) ? $data['UpdateURI'] : '',
		'active'       => in_array( $file, $all_active, true ),
	);
}

// get_plugins() skips files without a plugin header, so an emptied implant stays active yet unlisted
$unlisted_active = array();
foreach ( $all_active as $file ) {
	if ( isset( $installed[ $file ] ) ) {
		continue;
	}
	$path   = WP_PLUGIN_DIR . '/' . $file;
	$exists = file_exists( $path );
	$state  = 'missing';
	if ( $exists ) {
		$state = 0 === filesize( $path ) ? 'empty' : 'no plugin header';
	}
	$unlisted_active[] = array(
		'file'     => $file,
		'state'    => $state,
		'bytes'    => $exists ? filesize( $path ) : null,
		'modified' => $exists ? gmdate( 'Y-m-d\TH:i:s\Z', filemtime( $path ) ) : null,
	);
}

$themes = array();
foreach ( wp_get_themes( array( 'errors' => null ) ) as $slug => $theme ) {
	$themes[] = array(
		'slug'       => $slug,
		'name'       => $theme->get( 'Name' ),
		'version'    => $theme->get( 'Version' ),
		'author'     => wp_strip_all_tags( (string) $theme->get( 'Author' ) ),
		'parent'     => $theme->get_template() !== $slug ? $theme->get_template() : null,
		'update_uri' => (string) $theme->get( 'UpdateURI' ),
	);
}

// The dashboard caches its PHP check per md5(PHP_VERSION), so the keys name the versions FPM served there in the last week
$transient_prefix = '_site_transient_php_check_';
$checks           = is_multisite()
	? $wpdb->get_col( $wpdb->prepare( "SELECT meta_key FROM {$wpdb->sitemeta} WHERE meta_key LIKE %s", $wpdb->esc_like( $transient_prefix ) . '%' ) )
	: $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( $transient_prefix ) . '%' ) );
$hashes           = array();
foreach ( $checks as $name ) {
	$hashes[ substr( $name, strlen( $transient_prefix ) ) ] = true;
}
$dashboard_php = array();
foreach ( array( 5, 7, 8 ) as $major ) {
	for ( $minor = 0; $minor <= 9; $minor++ ) {
		for ( $patch = 0; $patch <= 60; $patch++ ) {
			$version = "$major.$minor.$patch";
			if ( isset( $hashes[ md5( $version ) ] ) ) {
				$expires         = (int) get_site_option( '_site_transient_timeout_php_check_' . md5( $version ) );
				$dashboard_php[] = array(
					'version' => $version,
					'checked' => $expires ? gmdate( 'Y-m-d\TH:i:s\Z', $expires - WEEK_IN_SECONDS ) : null,
				);
				unset( $hashes[ md5( $version ) ] );
			}
		}
	}
}

$relative = function ( $path ) {
	$docroot = rtrim( ABSPATH, '/' );
	return 0 === strpos( $path, $docroot . '/' ) ? substr( $path, strlen( $docroot ) + 1 ) : $path;
};

echo wp_json_encode(
	array(
		'core'                    => get_bloginfo( 'version' ),
		'locale'                  => get_locale(),
		'home'                    => home_url(),
		'siteurl'                 => site_url(),
		'multisite'               => is_multisite(),
		'table_prefix'            => $wpdb->prefix,
		'php_cli'                 => PHP_VERSION,
		'php_dashboard'           => $dashboard_php,
		'php_dashboard_unmatched' => count( $hashes ),
		'plugin_dir'              => $relative( WP_PLUGIN_DIR ),
		'theme_root'              => $relative( get_theme_root() ),
		'active_theme'            => get_stylesheet(),
		'parent_theme'            => get_template(),
		'plugins'                 => $plugins,
		'active_plugins'          => $all_active,
		'unlisted_active'         => $unlisted_active,
		'mu_plugins'              => array_keys( get_mu_plugins() ),
		'dropins'                 => array_keys( get_dropins() ),
		'themes'                  => $themes,
	)
) . "\n";
