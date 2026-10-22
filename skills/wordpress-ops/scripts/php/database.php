<?php
// Indicator values are SQL LIKE patterns; the output holds names and lengths, never values
// Every table prefix is searched, since a dormant second install is a place to hide
global $wpdb;
$input   = json_decode( base64_decode( $args[0] ), true );
$markers = array( '<script', '<iframe', '<?php', 'eval(', 'assert(', 'create_function', 'base64_decode(', 'gzinflate(', 'str_rot13(', 'fromCharCode', 'atob(', 'document.write' );

$tables_with = function ( $suffix, $column ) use ( $wpdb ) {
	$tables = array();
	foreach ( $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', '%' . $wpdb->esc_like( $suffix ) ) ) as $table ) {
		if ( $wpdb->get_var( $wpdb->prepare( "SHOW COLUMNS FROM `$table` LIKE %s", $column ) ) ) {
			$tables[] = $table;
		}
	}
	return $tables;
};

$options_tables = $tables_with( 'options', 'option_name' );
$users_tables   = $tables_with( 'users', 'user_login' );

$conditions = array();
foreach ( $markers as $marker ) {
	$conditions[] = $wpdb->prepare( 'option_value LIKE %s', '%' . $wpdb->esc_like( $marker ) . '%' );
}
$code_options = array();
foreach ( $options_tables as $table ) {
	foreach ( $wpdb->get_results( "SELECT option_name, option_value, autoload FROM `$table` WHERE " . implode( ' OR ', $conditions ) ) as $row ) {
		$found = array();
		foreach ( $markers as $marker ) {
			if ( false !== stripos( $row->option_value, $marker ) ) {
				$found[] = $marker;
			}
		}
		$code_options[] = array(
			'table'        => $table,
			'name'         => $row->option_name,
			'bytes'        => strlen( $row->option_value ),
			'autoload'     => $row->autoload,
			'is_transient' => 1 === preg_match( '/^_(site_)?transient_/', $row->option_name ),
			'markers'      => $found,
		);
	}
}

// Raw rather than through get_option(), with objects refused, since the stored value may be hostile
$cron_hooks_in = function ( $table ) use ( $wpdb ) {
	$stored = $wpdb->get_var( "SELECT option_value FROM `$table` WHERE option_name = 'cron'" );
	$cron   = is_string( $stored ) ? @unserialize( $stored, array( 'allowed_classes' => false ) ) : false;
	$hooks  = array();
	foreach ( is_array( $cron ) ? $cron : array() as $timestamp => $events ) {
		if ( ! is_array( $events ) ) {
			continue;
		}
		foreach ( $events as $hook => $instances ) {
			if ( ! isset( $hooks[ $hook ] ) ) {
				$hooks[ $hook ] = array(
					'hook'      => (string) $hook,
					'next'      => gmdate( 'Y-m-d\TH:i:s\Z', (int) $timestamp ),
					'schedules' => array(),
				);
			}
			foreach ( (array) $instances as $event ) {
				$hooks[ $hook ]['schedules'][] = is_array( $event ) && ! empty( $event['schedule'] ) ? $event['schedule'] : 'once';
			}
			$hooks[ $hook ]['schedules'] = array_values( array_unique( $hooks[ $hook ]['schedules'] ) );
		}
	}
	return array_values( $hooks );
};

$like_to_regex = function ( $like ) {
	$regex = '';
	foreach ( preg_split( '/(\\\\.|%|_)/', $like, -1, PREG_SPLIT_DELIM_CAPTURE ) as $part ) {
		if ( '%' === $part ) {
			$regex .= '.*';
		} elseif ( '_' === $part ) {
			$regex .= '.';
		} elseif ( 2 === strlen( $part ) && '\\' === $part[0] ) {
			$regex .= preg_quote( $part[1], '~' );
		} else {
			$regex .= preg_quote( $part, '~' );
		}
	}
	return '~^' . $regex . '$~is';
};

$name_hits = array();
foreach ( $input['indicators'] as $indicator ) {
	$value = $indicator['value'];
	if ( 'option-name' === $indicator['kind'] ) {
		foreach ( $options_tables as $table ) {
			foreach ( $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM `$table` WHERE option_name LIKE %s", $value ) ) as $name ) {
				$name_hits[] = array(
					'key'   => $indicator['key'],
					'table' => $table,
					'name'  => $name,
				);
			}
		}
	} elseif ( 'cron-hook' === $indicator['kind'] ) {
		foreach ( $options_tables as $table ) {
			foreach ( $cron_hooks_in( $table ) as $hook ) {
				if ( preg_match( $like_to_regex( $value ), $hook['hook'] ) ) {
					$name_hits[] = array(
						'key'   => $indicator['key'],
						'table' => $table,
						'name'  => $hook['hook'],
					);
				}
			}
		}
	} elseif ( 'user-login' === $indicator['kind'] || 'user-email' === $indicator['kind'] ) {
		$column = 'user-login' === $indicator['kind'] ? 'user_login' : 'user_email';
		foreach ( $users_tables as $table ) {
			foreach ( $wpdb->get_results( $wpdb->prepare( "SELECT user_login, $column AS matched FROM `$table` WHERE $column LIKE %s", $value ) ) as $row ) {
				$name_hits[] = array(
					'key'   => $indicator['key'],
					'table' => $table,
					'name'  => $row->matched,
					'login' => $row->user_login,
				);
			}
		}
	}
}

echo wp_json_encode(
	array(
		'prefix'         => $wpdb->prefix,
		'options_tables' => $options_tables,
		'users_tables'   => $users_tables,
		'code_options'   => $code_options,
		'cron_hooks'     => $cron_hooks_in( $wpdb->options ),
		'name_hits'      => $name_hits,
	)
) . "\n";
