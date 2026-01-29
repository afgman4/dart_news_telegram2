module.exports = {
  'secret' :  '',
  'db_info': {
    local: { // localhost
      host: 'aws-rds.ck6mh6yu6oys.ap-northeast-2.rds.amazonaws.com',
      port: '3306',
      user: 'root',
      password: 'rlatjdgus!1',
      database: 'news'
      
    },
    real: { // real
      host: '',
      port: '',
      user: '',
      password: '',
      database: ''
    },
    dev: { // dev
      host: '',
      port: '',
      user: '',
      password: '',
      database: ''
    }
  },
  'federation' : {
    'naver' : {
      'client_id' : '11',
      'secret_id' : '11',
      'callback_url' : '/auth/login/naver/callback'
    },
    'facebook' : {
      'client_id' : '11',
      'secret_id' : '11',
      'callback_url' : '/auth/login/facebook/callback'
    },
    'kakao' : {
      'client_id' : '11',
      'callback_url' : '/auth/login/kakao/callback'
    }
  }
};