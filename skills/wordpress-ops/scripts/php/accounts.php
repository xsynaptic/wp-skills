<?php
// Arguments: recent-registration window in days; prints counts and dates, never secrets
$powerful = array( 'manage_options', 'install_plugins', 'activate_plugins', 'edit_plugins', 'edit_themes', 'edit_users', 'promote_users', 'create_users', 'unfiltered_html', 'unfiltered_upload' );
$recent   = time() - (int) $args[0] * DAY_IN_SECONDS;
$roles    = array_keys( wp_roles()->roles );
$supers   = is_multisite() ? get_super_admins() : array();

function wordpress_ops_date( $timestamp ) {
	return $timestamp ? gmdate( 'Y-m-d\TH:i:s\Z', (int) $timestamp ) : null;
}

$flagged = array();
foreach ( get_users( array( 'blog_id' => 0 ) ) as $user ) {
	$capabilities = array_keys( array_filter( $user->allcaps ) );
	$risky        = array_values( array_intersect( $capabilities, $powerful ) );
	// Caps granted per user instead of through a role are how a backdoor elevates an ordinary account
	$direct    = array_values( array_diff( array_keys( array_filter( $user->caps ) ), $roles ) );
	$is_recent = strtotime( $user->user_registered . ' UTC' ) > $recent;

	$passwords = array();
	foreach ( (array) get_user_meta( $user->ID, '_application_passwords', true ) as $password ) {
		if ( ! is_array( $password ) ) {
			continue;
		}
		$passwords[] = array(
			'name'      => isset( $password['name'] ) ? $password['name'] : '',
			'created'   => wordpress_ops_date( isset( $password['created'] ) ? $password['created'] : 0 ),
			'last_used' => wordpress_ops_date( isset( $password['last_used'] ) ? $password['last_used'] : 0 ),
		);
	}

	$is_super = in_array( $user->user_login, $supers, true );
	if ( ! $risky && ! $direct && ! $is_recent && ! $passwords && ! $is_super ) {
		continue;
	}

	$newest_login = 0;
	$sessions     = (array) get_user_meta( $user->ID, 'session_tokens', true );
	foreach ( $sessions as $session ) {
		if ( is_array( $session ) && isset( $session['login'] ) ) {
			$newest_login = max( $newest_login, (int) $session['login'] );
		}
	}

	$flagged[] = array(
		'login'                 => $user->user_login,
		'email'                 => $user->user_email,
		'registered'            => $user->user_registered,
		'is_recent'             => $is_recent,
		'roles'                 => array_values( $user->roles ),
		'is_super_admin'        => $is_super,
		'risky_caps'            => $risky,
		'direct_caps'           => $direct,
		'application_passwords' => $passwords,
		'sessions'              => count( array_filter( $sessions, 'is_array' ) ),
		'newest_login'          => wordpress_ops_date( $newest_login ),
	);
}

$counts = count_users();
echo wp_json_encode(
	array(
		'total'   => $counts['total_users'],
		'flagged' => $flagged,
	)
) . "\n";
