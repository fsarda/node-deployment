var childl = require('child_process');
var date = new Date();

process.on('message', function(m) {
    console.log("\n["+date+"] Executing child process with command " + m.command)
    childl.exec(m.command , m.options, sendToParent);
});


function sendToParent(error, stdout, stderr){
    process.send({ "code":error , "stdout": stdout, "stderr": stderr });    
}
