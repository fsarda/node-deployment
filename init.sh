#!/bin/bash

function start {
	echo "Starting..."
	deployment-node &
	echo "Done."
}

function stop {
	echo "Stopping..."
	killall deployment-node
	echo "Done."
}

function restart {
	stop
	start
}

$1
