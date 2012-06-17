var path = require('path');
var fs = require("fs");
var http = require("http");
var config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));


//This function sends messages to deployment server
//through url configured in config.json
function sendToDeploymentServer(message) {
    
    var options = {
	host: config.server.host,
	port: config.server.port,
	path: config.deploymentServerUrl,
	method: 'POST',
	headers: {
            "Content-Type": "application/json",
	}
    };

    var req = http.request(options,function(res){
	res.on('data',function(data){
            console.log(data);
	});
    });

    req.write(JSON.stringify(message));

    req.end();
    
}

exports.sendToDeploymentServer = sendToDeploymentServer;