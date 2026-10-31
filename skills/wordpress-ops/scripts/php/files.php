<?php
// Reads only; prints paths, sizes, dates, line numbers and masked config lines
$input          = json_decode( base64_decode( $args[0] ), true );
$docroot        = rtrim( ABSPATH, '/' );
$uploads        = rtrim( wp_get_upload_dir()['basedir'], '/' );
$recent         = time() - (int) $input['recentDays'] * DAY_IN_SECONDS;
$max_bytes      = 8 * 1024 * 1024;
$code_pattern   = '/\.(php\d?|phtml|phar|pht|inc)$/i';
$script_pattern = '/\.(cgi|pl|py|sh|shtml|asp|aspx)$/i';
$core_root      = array( 'index.php', 'wp-activate.php', 'wp-blog-header.php', 'wp-comments-post.php', 'wp-config-sample.php', 'wp-cron.php', 'wp-links-opml.php', 'wp-load.php', 'wp-login.php', 'wp-mail.php', 'wp-settings.php', 'wp-signup.php', 'wp-trackback.php', 'xmlrpc.php' );

$triage_patterns = array(
	array( 'call built from request input', 'high', '/\b(?:call_user_func(?:_array)?|array_map|array_walk|usort|register_shutdown_function)\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b|\$_(?:GET|POST|REQUEST|COOKIE)\s*\[[^\]]*\]\s*\(/' ),
	array( 'unserialize of request input', 'high', '/\b(?:maybe_)?unserialize\s*\(\s*(?:(?:wp_unslash|stripslashes|base64_decode)\s*\(\s*)?\$_(?:GET|POST|REQUEST|COOKIE)\b/' ),
	array( 'hash_equals against a literal', 'high', '/\bhash_equals\s*\(\s*[\'"][^\'"]{6,}[\'"]|\bhash_equals\s*\([^;]{0,200}?,\s*[\'"][^\'"]{6,}[\'"]\s*\)/' ),
	array( 'eval, assert or create_function', 'high', '/(?<![\w>$:])(?<!function )(?:eval|assert|create_function)\s*\(/' ),
	array( 'decode then execute', 'high', '/(?<![\w>$:])(?:eval|assert)\s*\(\s*@?\s*(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin|rawurldecode)\s*\(/i' ),
	array( 'plugin or user list filtered', 'high', '/\badd_(?:filter|action)\s*\(\s*[\'"](?:all_plugins|pre_user_query|users_list_table_query_args|views_users)[\'"]/' ),
	array( 'auth cookie set', 'high', '/\b(?:wp_set_auth_cookie|wp_set_current_user)\s*\(/' ),
	array( 'user or capability write', 'high', '/\b(?:wp_insert_user|wp_create_user|wp_update_user|add_cap|add_role|set_role|grant_super_admin)\s*\(/' ),
	array( 'SQL built from request input', 'high', '/[\'"]\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s[^;]*?\.\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b|\$wpdb->(?:query|get_results|get_row|get_var|get_col)\s*\((?![^;]*->prepare\s*\()[^;]*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b/i' ),
	array( 'SQL escaped by hand', 'review', '/[\'"]\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s[^;]*?\b(?:addslashes|mysql_real_escape_string|mysql_escape_string)\s*\(/i' ),
	array( 'request input printed raw', 'review', '/(?:\becho\b|\bprint\b|<\?=)(?:(?:(?!\?>|esc_\w+\s*\(|htmlspecialchars|htmlentities|wp_kses|absint|intval)[^;])*?\.)?\s*(?:\$_(?:GET|POST|REQUEST|COOKIE)\s*\[|\$_SERVER\s*\[\s*[\'"](?:REQUEST_URI|PHP_SELF|QUERY_STRING|HTTP_\w+)[\'"])/' ),
	array( 'nopriv AJAX handler', 'review', '/[\'"]wp_ajax_nopriv_/' ),
	array( 'REST route open to anyone', 'review', '/[\'"]permission_callback[\'"]\s*=>\s*[\'"]__return_true[\'"]/' ),
	array( 'login hook or password read', 'review', '/\badd_(?:filter|action)\s*\(\s*[\'"](?:authenticate|wp_authenticate|wp_authenticate_user|wp_login|check_password)[\'"]|\$_(?:POST|REQUEST)\s*\[\s*[\'"]pwd[\'"]/' ),
	array( 'remote call', 'review', '/\b(?:wp_remote_(?:get|post|request|head)|wp_safe_remote_(?:get|post|request)|curl_exec|fsockopen|stream_socket_client)\s*\(|\bfile_get_contents\s*\(\s*[\'"]https?:/' ),
	array( 'URL with an IP address for a host', 'review', '/[\'"]https?:\/\/(?!127\.)\d{1,3}(?:\.\d{1,3}){3}\b/' ),
	array( 'file write', 'review', '/\b(?:file_put_contents|fwrite|fputs|move_uploaded_file)\s*\(/' ),
);

// eval-file runs inside a method, so these are closures over its locals rather than functions reading globals
$relative_to_docroot = function ( $path ) use ( $docroot ) {
	return 0 === strpos( $path, $docroot . '/' ) ? substr( $path, strlen( $docroot ) + 1 ) : $path;
};

$format_date = function ( $timestamp ) {
	return gmdate( 'Y-m-d\TH:i:s\Z', (int) $timestamp );
};

$component_roots = array(
	'mu-plugins' => WPMU_PLUGIN_DIR,
	'plugins'    => WP_PLUGIN_DIR,
	'themes'     => get_theme_root(),
);
$root_of         = function ( $path ) use ( $docroot, $component_roots ) {
	if ( dirname( $path ) === $docroot ) {
		return 'root';
	}
	foreach ( $component_roots as $root => $directory ) {
		if ( 0 === strpos( $path, $directory . '/' ) ) {
			return $root;
		}
	}
	return null;
};

$file_string_hits = array();
$match_strings    = function ( $path, $content, $root ) use ( $input, $relative_to_docroot, &$file_string_hits ) {
	foreach ( $input['fileStrings'] as $indicator ) {
		if ( ! in_array( $root, $indicator['roots'], true ) ) {
			continue;
		}
		$is_hit = 'regex' === $indicator['match']
			? 1 === preg_match( '~' . str_replace( '~', '\~', $indicator['value'] ) . '~', $content )
			: false !== strpos( $content, $indicator['value'] );
		if ( $is_hit ) {
			$file_string_hits[] = array(
				'key'  => $indicator['key'],
				'path' => $relative_to_docroot( $path ),
			);
		}
	}
};

$is_silent = function ( $content ) {
	return 1 === preg_match( '~^<\?php\s*(//\s*Silence is golden\.?)?\s*$~i', trim( $content ) );
};

$triage = function ( $content ) use ( $triage_patterns ) {
	$hits = array();
	foreach ( $triage_patterns as $pattern ) {
		list( $label, $severity, $regex ) = $pattern;
		if ( ! preg_match_all( $regex, $content, $matches, PREG_OFFSET_CAPTURE ) ) {
			continue;
		}
		$lines = array();
		foreach ( array_slice( $matches[0], 0, 3 ) as $match ) {
			$lines[] = substr_count( $content, "\n", 0, $match[1] ) + 1;
		}
		$hits[ $label ] = array(
			'severity' => $severity,
			'count'    => count( $matches[0] ),
			'lines'    => $lines,
		);
	}
	// A nonce check anywhere in the file clears it; reading the guard is still the reviewer's job
	if ( preg_match( '/\b(?:update_option|add_option|delete_option|update_(?:user|post)_meta|wp_(?:insert|update|delete)_post|\$wpdb->(?:query|insert|update|delete|replace))\s*\([^;]*\$_(?:GET|POST|REQUEST)\s*\[/', $content, $match, PREG_OFFSET_CAPTURE )
		&& ! preg_match( '/\b(?:check_admin_referer|check_ajax_referer|wp_verify_nonce)\s*\(/', $content ) ) {
		$hits['request handled with no nonce check'] = array(
			'severity' => 'review',
			'count'    => 1,
			'lines'    => array( substr_count( $content, "\n", 0, $match[0][1] ) + 1 ),
		);
	}
	return $hits;
};

$describe = function ( $path, $content ) use ( $relative_to_docroot, $format_date, $triage ) {
	return array(
		'path'     => $relative_to_docroot( $path ),
		'bytes'    => filesize( $path ),
		'modified' => $format_date( filemtime( $path ) ),
		'triage'   => null === $content ? null : $triage( $content ),
	);
};

$walk = function ( $root, $skip, $max_depth = -1 ) {
	$directory = new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS );
	$filtered  = new RecursiveCallbackFilterIterator(
		$directory,
		function ( $file ) use ( $skip ) {
			return ! ( $file->isDir() && in_array( $file->getPathname(), $skip, true ) );
		}
	);
	$iterator  = new RecursiveIteratorIterator( $filtered, RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD );
	$iterator->setMaxDepth( $max_depth );
	return $iterator;
};

$directives = array();
// Handler lines are routine in WordPress's own .htaccess but make files execute in uploads or a legacy folder
$read_directives = function ( $path, $reads_handlers ) use ( &$directives, $relative_to_docroot ) {
	$base = basename( $path );
	if ( '.user.ini' === $base ) {
		$pattern = '/^\s*(auto_prepend_file|auto_append_file)\s*=/i';
	} elseif ( $reads_handlers ) {
		$pattern = '/^\s*(php_value\s+auto_(prepend|append)_file|AddHandler|SetHandler|AddType|php_flag\s+engine)\b/i';
	} else {
		$pattern = '/^\s*php_value\s+auto_(prepend|append)_file\b/i';
	}
	$lines = @file( $path, FILE_IGNORE_NEW_LINES );
	foreach ( false === $lines ? array() : $lines as $index => $line ) {
		if ( preg_match( $pattern, $line ) ) {
			$directives[] = array(
				'path' => $relative_to_docroot( $path ),
				'line' => $index + 1,
				'text' => substr( trim( $line ), 0, 240 ),
			);
		}
	}
};

$triage_targets = array_values( array_filter( (array) $input['triage'] ) );
$hooks_left     = array_fill_keys( (array) $input['hooks'], true );
$components     = array();
$root_php       = array();
$mu_plugins     = array();
$dropins        = array();
$recent_php     = array();
$outside        = array();
$walked         = array(
	'files'  => 0,
	'bytes'  => 0,
	'unread' => array(),
);

foreach ( $walk( $docroot, array( $uploads, WP_CONTENT_DIR . '/cache' ) ) as $path => $file ) {
	if ( ! $file->isFile() ) {
		continue;
	}
	$base     = $file->getFilename();
	$relative = $relative_to_docroot( $path );
	// Old static trees and other apps share the docroot and PHP pool, and no checksum or component triage covers them
	$is_outside = dirname( $path ) !== $docroot
		&& 0 !== strpos( $path, WP_CONTENT_DIR . '/' )
		&& ! preg_match( '~^(wp-admin|' . WPINC . ')/~', $relative );
	if ( '.user.ini' === $base || '.htaccess' === $base ) {
		$read_directives( $path, $is_outside );
		continue;
	}
	if ( ! preg_match( $code_pattern, $base ) && ! ( $is_outside && preg_match( $script_pattern, $base ) ) ) {
		continue;
	}
	$size = $file->getSize();
	if ( $file->getMTime() > $recent ) {
		$recent_php[] = array(
			'path'     => $relative,
			'modified' => $format_date( $file->getMTime() ),
		);
	}
	$content = $size > $max_bytes ? null : @file_get_contents( $path );
	if ( null === $content || false === $content ) {
		$walked['unread'][] = $relative;
		$content            = null;
	} else {
		++$walked['files'];
		$walked['bytes'] += $size;
		foreach ( array_keys( $hooks_left ) as $hook ) {
			if ( false !== strpos( $content, $hook ) ) {
				unset( $hooks_left[ $hook ] );
			}
		}
		$root = $root_of( $path );
		if ( null !== $root ) {
			$match_strings( $path, $content, $root );
		}
	}

	$directory = dirname( $path );
	if ( $directory === $docroot ) {
		$entry                 = $describe( $path, $content );
		$entry['is_core_name'] = in_array( $base, $core_root, true );
		$entry['is_config']    = 'wp-config.php' === $base;
		$root_php[]            = $entry;
		continue;
	}
	if ( $is_outside ) {
		$outside[] = $describe( $path, $content );
		continue;
	}
	if ( 0 === strpos( $path, WPMU_PLUGIN_DIR . '/' ) ) {
		$mu_plugins[] = $describe( $path, $content );
		continue;
	}
	if ( WP_CONTENT_DIR === $directory ) {
		if ( null === $content || ! $is_silent( $content ) ) {
			$dropins[] = $describe( $path, $content );
		}
		continue;
	}
	if ( null === $content ) {
		continue;
	}
	foreach ( $triage_targets as $target ) {
		if ( $relative !== $target && 0 !== strpos( $relative, $target . '/' ) ) {
			continue;
		}
		if ( ! isset( $components[ $target ] ) ) {
			$components[ $target ] = array(
				'files' => 0,
				'hits'  => array(),
			);
		}
		++$components[ $target ]['files'];
		foreach ( $triage( $content ) as $label => $hit ) {
			if ( ! isset( $components[ $target ]['hits'][ $label ] ) ) {
				$components[ $target ]['hits'][ $label ] = array(
					'severity' => $hit['severity'],
					'count'    => 0,
					'examples' => array(),
				);
			}
			$components[ $target ]['hits'][ $label ]['count'] += $hit['count'];
			foreach ( $hit['lines'] as $line ) {
				if ( count( $components[ $target ]['hits'][ $label ]['examples'] ) < 3 ) {
					$components[ $target ]['hits'][ $label ]['examples'][] = substr( $relative, strlen( $target ) + 1 ) . ':' . $line;
				}
			}
		}
		break;
	}
}

// Uploads should hold no code at all, and a PHP payload can sit behind an image extension
$uploads_php = array();
if ( is_dir( $uploads ) ) {
	foreach ( $walk( $uploads, array() ) as $path => $file ) {
		if ( ! $file->isFile() ) {
			continue;
		}
		$base = $file->getFilename();
		if ( '.user.ini' === $base || '.htaccess' === $base ) {
			$read_directives( $path, true );
			continue;
		}
		$reason = null;
		if ( preg_match( $code_pattern, $base ) ) {
			$reason = 'code extension';
		} else {
			$head = @file_get_contents( $path, false, null, 0, 4096 );
			// A bare `<?=` turns up by chance in compressed image data; a short echo tag that runs something has an operand
			if ( false !== $head && preg_match( '/<\?php\b|<\?=\s*(?:`|\$_|[a-z_]\w*\s*\()/i', $head ) ) {
				$reason = 'PHP tag in the first 4 KB';
			}
		}
		if ( null === $reason ) {
			continue;
		}
		$content = $file->getSize() > $max_bytes ? null : @file_get_contents( $path );
		if ( null !== $content && false !== $content && $is_silent( $content ) ) {
			continue;
		}
		if ( null !== $content && false !== $content ) {
			$match_strings( $path, $content, 'uploads' );
		}
		$entry           = $describe( $path, false === $content ? null : $content );
		$entry['reason'] = $reason;
		$uploads_php[]   = $entry;
	}
}

$above  = array();
$parent = dirname( $docroot );
foreach ( $walk( $parent, array( $docroot ), 1 ) as $path => $file ) {
	if ( ! $file->isFile() ) {
		continue;
	}
	$base = $file->getFilename();
	if ( '.user.ini' === $base || '.htaccess' === $base ) {
		$read_directives( $path, false );
		continue;
	}
	if ( preg_match( $code_pattern, $base ) ) {
		$content = $file->getSize() > $max_bytes ? null : @file_get_contents( $path );
		$above[] = $describe( $path, false === $content ? null : $content );
	}
}

// Code after the wp-settings.php require runs on every request yet sits where nobody edits
$config_tail = array();
$config_path = file_exists( $docroot . '/wp-config.php' ) ? $docroot . '/wp-config.php' : $parent . '/wp-config.php';
$config      = @file( $config_path, FILE_IGNORE_NEW_LINES );
$is_after    = false;
foreach ( false === $config ? array() : $config as $index => $line ) {
	if ( $is_after && '' !== trim( $line ) && ! preg_match( '~^\s*(//|#|/?\*)~', $line ) ) {
		$config_tail[] = array(
			'line' => $index + 1,
			'text' => preg_replace_callback(
				'/([\'"])((?:\\\\.|(?!\1).)*)\1/',
				function ( $quoted ) {
					return "'<" . strlen( $quoted[2] ) . " chars>'";
				},
				substr( trim( $line ), 0, 240 )
			),
		);
	}
	if ( preg_match( '/^\s*(require|include)(_once)?\b.*wp-settings\.php/', $line ) ) {
		$is_after = true;
	}
}

// Only combined-format access lines carry method, path, status, reply size and user agent together
$request_hits = array();
$logs_read    = 0;
$logs_failed  = array();
$combined     = '/"([A-Z]+) (\S+)[^"]*" (\d{3}) (\d+|-) "[^"]*" "([^"]*)"/';
$record       = function ( $key, $path, $line ) use ( &$request_hits ) {
	if ( ! isset( $request_hits[ $key ] ) ) {
		$request_hits[ $key ] = array(
			'key'      => $key,
			'count'    => 0,
			'examples' => array(),
		);
	}
	++$request_hits[ $key ]['count'];
	if ( count( $request_hits[ $key ]['examples'] ) < 10 ) {
		$request_hits[ $key ]['examples'][] = basename( $path ) . ': ' . substr( rtrim( $line ), 0, 240 );
	}
};
if ( ! empty( $input['logRoot'] ) && ! empty( $input['requests'] ) && is_dir( $input['logRoot'] ) ) {
	foreach ( $walk( $input['logRoot'], array() ) as $path => $file ) {
		if ( ! $file->isFile() ) {
			continue;
		}
		$source = preg_match( '/\.gz$/', $path ) ? 'compress.zlib://' . $path : $path;
		$handle = @fopen( $source, 'r' );
		if ( false === $handle ) {
			$logs_failed[] = $path;
			continue;
		}
		++$logs_read;
		while ( false !== ( $line = fgets( $handle ) ) ) {
			$is_shape_match = false;
			$is_labelled    = false;
			foreach ( $input['requests'] as $indicator ) {
				if ( false === strpos( $line, '"' . $indicator['method'] . ' ' . $indicator['path'] . ' ' ) || ! preg_match( $combined, $line, $fields ) ) {
					continue;
				}
				if ( $fields[1] !== $indicator['method'] || $fields[2] !== $indicator['path'] || ! preg_match( '~' . str_replace( '~', '\\~', $indicator['userAgent'] ) . '~', $fields[5] ) ) {
					continue;
				}
				$is_shape_match = true;
				$bytes          = '-' === $fields[4] ? 0 : (int) $fields[4];
				$range          = $indicator['responseBytes'];
				if ( is_array( $range ) && ( $bytes < $range[0] || $bytes > $range[1] ) ) {
					continue;
				}
				$is_labelled = true;
				$record( $indicator['key'], $path, $line );
			}
			if ( $is_shape_match && ! $is_labelled ) {
				$record( 'unlabelled', $path, $line );
			}
		}
		fclose( $handle );
	}
}

usort(
	$recent_php,
	function ( $first, $second ) {
		return strcmp( $second['modified'], $first['modified'] );
	}
);

echo wp_json_encode(
	array(
		'root_php'           => $root_php,
		'above_docroot'      => $above,
		'mu_plugins'         => $mu_plugins,
		'dropins'            => $dropins,
		'uploads_php'        => $uploads_php,
		'outside_wordpress'  => $outside,
		'directives'         => $directives,
		'config_tail'        => $config_tail,
		'components'         => (object) $components,
		'unreferenced_hooks' => array_keys( $hooks_left ),
		'file_string_hits'   => $file_string_hits,
		'request_hits'       => array_values( $request_hits ),
		'logs_read'          => $logs_read,
		'logs_failed'        => $logs_failed,
		'recent_php'         => array(
			'count'  => count( $recent_php ),
			'newest' => array_slice( $recent_php, 0, 20 ),
		),
		'walked'             => $walked,
	)
) . "\n";
