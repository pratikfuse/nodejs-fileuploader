require('dotenv').config();
var express = require('express');
var app = express();
var path = require('path');
const config = require("./config");
const AWS = require('aws-sdk');
const formidable = require('formidable');
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const sharp = require('sharp');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { promisify } = require('util');
const debug = require('debug')('file-uploader');
const chalk = require('chalk')

function createResponsiveImages(file) {
    const sharp_image = sharp(file, { sequentialRead: true });
      
    return {
        original: sharp_image.toBuffer(),
        large: sharp_image.resize(1000).toBuffer(),
        medium: sharp_image.resize(500).toBuffer(),
        small: sharp_image.resize(200).toBuffer()
    }
}

const port = 3000;
app.use(express.static(path.join(__dirname, '/')));
let appSocket = null;

AWS.config.update({
    accessKeyId: config.id,
    secretAccessKey: config.secret,
    region: config.region
})

const s3 = new AWS.S3();

app.get('/', (req, res) => {
    res.sendFile(path.join(`${__dirname}/advance_upload.html`));
});

io.on('connection', (socket) => {
    appSocket = socket;
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

app.post('/uploads/v2', (req, res) => {
    const service_id = uuidv4() + "/posts/images";
    const bucket_name = "superapp-upload-services";
    const upload_s3_folder = bucket_name + "/" + service_id
    const max_upload_size = 1024 * 1024 * 4;
    const max_upload_counts = 10;
    let response_message = "all files uploaded";

    const file_upload_options = {
        multiples: true,
        maxFileSize: max_upload_size * max_upload_counts,
        keepExtentions: true
    };

    // create dynamic bucket
    const serviceBucket = {
        Bucket: upload_s3_folder,
        CreateBucketConfiguration: {
            LocationConstraint: "ap-south-1"
        }
    };

    s3.createBucket(serviceBucket, function(err, data) {
        if (err) {
            if(err.statusCode === 409) {
                debug(chalk.yellow(err.message));
            }
        }
        else debug('Bucket created successfully', JSON.stringify(data))
    });

    const form = formidable(file_upload_options);

    form.parse(req, async (err, fields, fileObject) => {
        if (err) {
            debug(chalk.yellow(err.message));
            return res.status(500).send(err.message);
        }

        if(!fileObject.hasOwnProperty('files')) {
            response_message = "please select some files to upload";
            return form.emit('error', new Error(response_message));
        }

        if (fileObject.files.hasOwnProperty('length') && fileObject.files.length > max_upload_counts) {
            response_message = `please remove some images, only ${max_upload_counts} files are allowed to upload`;
            return form.emit('error', new Error(response_message));
        }
        
        const images = getImages(fileObject.files);

        if(images.ignored.length) {
            debug('some files are ignored')
        };

        if (!images.files.length > 0) {
            return form.emit('error', new Error("invalid files given."));
        }

        debug(`\nuploading ${images.files.length} files..`)

        // create local upload dir if local upload is enabled
        if (config.local_upload.enable) {
            checkFolderExists(config.local_upload.dir.services)
        }
            
        try {
            for (let file of images.files) {
                const resizedImages = createResponsiveImages(file.path);

                const responsive_images = {
                    original: await resizedImages.original.catch((err) => debug(chalk.yellow(err.message))),
                    large: await resizedImages.large.catch((err) => debug(chalk.yellow(err.message))),
                    medium: await resizedImages.medium.catch((err) => debug(chalk.yellow(err.message))),
                    small: await resizedImages.small.catch((err) => debug(chalk.yellow(err.message))),
                };
                
                // check file is undefined or not
                if (responsive_images.original === undefined) {
                    debug(chalk.yellow('unsupported file is given to upload'))
                    continue;
                }

                const original_filename = file.name.toLowerCase().replace(/ /g, "");
                const filename = createRandomFileName(original_filename);
    
                // upload file if local upload is enabled
                if (config.local_upload.enable) {
                    debug('local backup upload is enabled....');

                    await uploadLocally({
                        file: responsive_images.original,
                        filename: filename,
                        upload_root_path: config.local_upload.dir.services,
                        upload_path: config.local_upload.dir.services + "/" + service_id
                    });
            
                    await uploadLocally({
                        file: responsive_images.large,
                        filename: "lg_" + filename,
                        upload_root_path: config.local_upload.dir.services,
                        upload_path: config.local_upload.dir.services + "/" + service_id
                    });
            
                    await uploadLocally({
                        file: responsive_images.medium,
                        filename: "md_" + filename,
                        upload_root_path: config.local_upload.dir.services,
                        upload_path: config.local_upload.dir.services + "/" + service_id
                    });
            
                    await uploadLocally({
                        file: responsive_images.small,
                        filename: "sm_" + filename,
                        upload_root_path: config.local_upload.dir.services,
                        upload_path: config.local_upload.dir.services + "/" + service_id
                    });
                }

                // upload to aws S3
                const params = [
                    {
                        Bucket: bucket_name,
                        Key: service_id + "/"+ filename,
                        ContentType: file.type,
                        ACL: "public-read",
                        Body: responsive_images.original
                    },
                    {
                        Bucket: bucket_name,
                        Key: service_id + "/"+"lg_" + filename,
                        ContentType: file.type,
                        ACL: "public-read",
                        Body: responsive_images.large
                    },
                    {
                        Bucket: bucket_name,
                        Key: service_id + "/"+"md_" + filename,
                        ContentType: file.type,
                        ACL: "public-read",
                        Body: responsive_images.medium
                    },
                    {
                        Bucket: bucket_name,
                        Key: service_id + "/"+"sm_" + filename,
                        ContentType: file.type,
                        ACL: "public-read",
                        Body: responsive_images.small
                    }
                ]
    
                for (let param of params) {
                    s3.upload(param, function(err, data) {
                        if (err) debug(chalk.yellow(err.message));
                        else debug('File uploaded successfully', JSON.stringify(data))
                    });
                }
            }
        } catch (error) {
            debug(chalk.yellow(err.message));
        };
        
        return res.send(response_message);
    });
    

    form.on('progress', (bytesReceived, bytesExpected) => {
        var progress = {
            type: 'progress',
            bytesReceived,
            bytesExpected
        };

        appSocket.emit('upload', JSON.stringify(progress));
    });
});


function createRandomFileName(oldFilename) {
    const filenameChunk = oldFilename.split("."); 
    const extention = "." + filenameChunk[filenameChunk.length - 1];
    return generateRandomString() + extention;
}

function generateRandomString() {
    const secret = "AJ!@!*(&@((^(*^YIU";
    const algo = 'sha256';
    const random_string = Math.random().toString() + Date.now().toString();
    
    const hmac = crypto.createHmac(algo, secret).update(random_string).digest('hex');
    return hmac
}

function getImages(fileObject) {
    let filteredImages = [];
    let ignoredImages = [];

    if(fileObject.hasOwnProperty('length')) {
        const files = fileObject;
        for(let file of files) {
            if (mimeTypeIsAllow(file.type)) {
                filteredImages.push(file);
            } else {
                ignoredImages.push(file);
            }
        }    
    } else {
        const file = fileObject;
        if(mimeTypeIsAllow(file.type)) {
            filteredImages.push(file);
        } else {
            ignoredImages.push(file);
        }
    }

    return {
        files: filteredImages,
        ignored: ignoredImages
    }
}

function mimeTypeIsAllow(mimeType) {
    const allowedMimeTypes = ["image/png", "image/jpeg", "image/webp"];
    return !!(allowedMimeTypes.indexOf(mimeType) >= 0)
}

function checkFolderExists(folder) {
    if (!fs.existsSync(folder)) {
        // Node > 10.12.0 now accepts a { recursive: true } option like so
        fs.mkdirSync(folder, { recursive: true })
    }
}

function uploadLocally(params) {
    try {
        // check permission to create, read and write file on upload path
        fs.accessSync(params.upload_root_path, fs.constants.R_OK | fs.constants.W_OK)

        const file = params.file;
        const filename = params.filename;
        const upload_path = params.upload_path;
        checkFolderExists(upload_path);

        const upload_to = path.resolve(upload_path, filename);
        const promisifyWriteFile = promisify(fs.writeFile);

        return promisifyWriteFile(upload_to, file);

    } catch (error) {
        debug(chalk.yellow(error.message));
    }
}

http.listen(port, () => console.log(`hello world app listening on port ${port}`));