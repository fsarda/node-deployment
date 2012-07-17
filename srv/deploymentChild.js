var childl = require('child_process');
var date = new Date();
var commandReceived = {};
var retryCount = 0;


process.on('message', function(m) {
    console.log("\n["+date+"] Executing child process with command " + m.command)
    commandReceived = m;
    childl.exec(m.command , m.options, sendToParent);
});


function sendToParent(error, stdout, stderr){

    console.log("\n["+date+"] Processing ending exec with response {" +error + ", "+stdout+ ", "+stderr+"}");

    // if(retryCount < commandReceived.retryCount && error != null){
    // 	retryCount++;
    // 	console.log("\n["+date+"] Retrying  " + commandReceived.command+" with attempt "+retryCount);
    // }else{
	process.send({ "code":error , "stdout": stdout, "stderr": stderr });    
    //}
}
