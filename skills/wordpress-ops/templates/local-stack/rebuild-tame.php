<?php
// Piped into `wp eval-file -` by rebuild.ts: switches off, in this database only, what keeps a production copy from serving plain http or logging in
// $args[0] is the local administrator's login, also its password

global $wpdb;
$applied = array();

$rsssl = get_option( 'rsssl_options' );
if ( is_array( $rsssl ) ) {
	$rsssl['ssl_enabled']         = false;
	$rsssl['mixed_content_fixer'] = false;
	$rsssl['redirect']            = 'none';
	update_option( 'rsssl_options', $rsssl );
	$applied[] = 'Really Simple Security 9.x: SSL flag, redirect and mixed-content fixer off';
}

// The 5.x option; a 9.x upgrade migrates from it on the first admin request, so rehearsing that upgrade starts from live's values
$legacy_rsssl = get_option( 'rlrsssl_options' );
if ( is_array( $legacy_rsssl ) ) {
	$legacy_rsssl['ssl_enabled']                = false;
	$legacy_rsssl['wp_redirect']                = false;
	$legacy_rsssl['autoreplace_insecure_links'] = false;
	update_option( 'rlrsssl_options', $legacy_rsssl );
	$applied[] = 'Really Simple SSL 5.x: SSL flag, redirect and link replacement off';
}

$modules = get_option( 'jetpack_active_modules' );
if ( is_array( $modules ) ) {
	$kept = array_values( array_diff( $modules, array( 'protect', 'account-protection' ) ) );
	if ( count( $kept ) !== count( $modules ) ) {
		update_option( 'jetpack_active_modules', $kept );
		$applied[] = 'Jetpack: Brute Force Protection and Account Protection off';
	}
}

$login = $args[0];
$user  = get_user_by( 'login', $login );
if ( $user ) {
	wp_set_password( $login, $user->ID );
	$user_id = $user->ID;
} else {
	$user_id = wp_insert_user(
		array(
			'user_login' => $login,
			'user_pass'  => $login,
			'user_email' => $login . '@example.test',
			'role'       => 'administrator',
		)
	);
}
if ( is_wp_error( $user_id ) ) {
	WP_CLI::error( $user_id->get_error_message() );
}
$applied[] = "administrator $login";

$wfls_settings = $wpdb->base_prefix . 'wfls_settings';
if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wfls_settings ) ) === $wfls_settings ) {
	$wpdb->query( "UPDATE `$wfls_settings` SET value = '' WHERE name IN ('enable-auth-captcha', 'required-2fa-role.administrator')" );
	// Clearing the role setting alone did not lift the 2FA block; the grace period on the user does
	update_user_meta( $user_id, 'wfls-allow-grace-period', '1' );
	update_user_meta( $user_id, 'wfls-grace-period-reset', (string) time() );
	update_user_meta( $user_id, 'wfls-grace-period-override', '3650' );
	$applied[] = "Wordfence: login reCAPTCHA and administrator 2FA off, grace period for $login";
}

WP_CLI::line( wp_json_encode( $applied ) );
