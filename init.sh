#!/bin/bash

function start {
	echo "Starting..."
	deployment-node &
	echo "Done."
}

function stop {
	echo "Stopping..."
	kill `ps -fC node | sed -n '/deployment-node/s/^[^0-9]*\([0-9]*\).*$/\1/gp'`
	echo "Done."
}

function restart {
	stop
	start
}

$1
