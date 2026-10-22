<?php
// Arguments: inspect <login> <post id>... | create <login> <auth|secure_auth> | remove <login> <post id>=<lock>...
global $wpdb;
$action = $args[0];
$login  = $args[1];

if ( 'inspect' === $action ) {
	$locks = array();
	foreach ( array_slice( $args, 2 ) as $post_id ) {
		$locks[ $post_id ] = (string) get_post_meta( (int) $post_id, '_edit_lock', true );
	}
	echo wp_json_encode(
		array(
			'user_exists' => (bool) username_exists( $login ),
			'locks'       => (object) $locks,
		)
	) . "\n";
	return;
}

if ( 'create' === $action ) {
	$user_id = wp_insert_user(
		array(
			'user_login' => $login,
			'user_email' => $login . '@localhost.invalid',
			'user_pass'  => wp_generate_password( 32 ),
			'role'       => 'administrator',
		)
	);
	if ( is_wp_error( $user_id ) ) {
		WP_CLI::error( $user_id );
	}
	// wp-admin over https checks the secure_auth cookie, over plain http the auth one
	$scheme     = 'secure_auth' === $args[2] ? 'secure_auth' : 'auth';
	$auth_name  = 'secure_auth' === $scheme ? SECURE_AUTH_COOKIE : AUTH_COOKIE;
	$expiration = time() + 2 * HOUR_IN_SECONDS;
	$cookie     = $auth_name . '=' . wp_generate_auth_cookie( $user_id, $expiration, $scheme ) . '; ' . LOGGED_IN_COOKIE . '=' . wp_generate_auth_cookie( $user_id, $expiration, 'logged_in' );
	echo wp_json_encode( array( 'cookie' => $cookie ) ) . "\n";
	return;
}

if ( 'remove' !== $action ) {
	WP_CLI::error( "unknown action $action" );
}

$deleted_posts = 0;
$user          = get_user_by( 'login', $login );
if ( $user ) {
	// Plugin post types aren't registered under --skip-plugins, so a post query by type would miss their auto-drafts
	$post_ids = $wpdb->get_col( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_author = %d", $user->ID ) );
	foreach ( $post_ids as $post_id ) {
		if ( wp_delete_post( (int) $post_id, true ) ) {
			++$deleted_posts;
		}
	}
	require_once ABSPATH . 'wp-admin/includes/user.php';
	wp_delete_user( $user->ID );
}

$locks = array();
foreach ( array_slice( $args, 2 ) as $pair ) {
	list( $post_id, $lock ) = explode( '=', $pair, 2 );
	if ( '' === $lock ) {
		delete_post_meta( (int) $post_id, '_edit_lock' );
	} else {
		update_post_meta( (int) $post_id, '_edit_lock', $lock );
	}
	$locks[ $post_id ] = (string) get_post_meta( (int) $post_id, '_edit_lock', true );
}

echo wp_json_encode(
	array(
		'deleted_posts' => $deleted_posts,
		'user_exists'   => (bool) username_exists( $login ),
		'locks'         => (object) $locks,
	)
) . "\n";
