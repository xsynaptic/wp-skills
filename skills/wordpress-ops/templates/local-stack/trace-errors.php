<?php
// Probe only: copy into site/wp-content/mu-plugins/ while attributing warnings, then delete
// Tags each notice, warning and deprecation with the first theme or plugin frame behind it, so a warning raised inside core names its caller
set_error_handler(
	function ( $level, $message, $file, $line ) {
		$caller = 'core';
		foreach ( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS ) as $frame ) {
			if ( ! isset( $frame['file'] ) || __FILE__ === $frame['file'] || false === strpos( $frame['file'], '/wp-content/' ) ) {
				continue;
			}
			$caller = substr( $frame['file'], strpos( $frame['file'], '/wp-content/' ) + strlen( '/wp-content/' ) ) . ':' . $frame['line'];
			break;
		}
		error_log( "TRACE [$caller] $message in " . str_replace( ABSPATH, '', $file ) . ":$line" );
		return false;
	}
);
