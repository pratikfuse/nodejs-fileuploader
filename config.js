// it's good practice to upload files outside web root folder

module.exports = {
    id: process.env.AWS_ID,
    secret: process.env.AWS_SECRET,
    region: 'ap-south-1',
    local_upload: {
        enable: true,
        dir: {
            users: "/home/devrabin/Documents/Tp/backend_packages/upload/uploads/users",
            services: "/home/devrabin/Documents/Tp/backend_packages/upload/uploads/service",
            log: "/var/log",
        },
    }
}